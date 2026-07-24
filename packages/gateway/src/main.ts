import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import type { PromptResponse, SessionSummary } from '@racecar/shim';
import { loadConfig } from './config.js';
import { GatewayStateStore } from './gateway-state.js';
import { gatewayProvider, ShimLaunchAdapter } from './launch-adapter.js';
import type { RunnerClaimResponse, RunnerFailureBody } from './overlord-runner-contract.js';
import { OverlordProtocolBridge } from './protocol-bridge.js';
import { SandboxWaker, type RunnerQueueStatus } from './sandbox-waker.js';
import { describeDurability, ensureDurableStateDir } from './state-durability.js';

const execFileAsync = promisify(execFile);

const config = loadConfig();
const provider = gatewayProvider();
const launchAdapter = new ShimLaunchAdapter({
  provider,
  stateDirectory: config.stateDirectory,
  overlord: {
    backendUrl: config.backendUrl,
    token: config.token,
    deviceFingerprint: config.deviceFingerprint,
  },
  ...(config.branchStrategy !== undefined ? { branchStrategy: config.branchStrategy } : {}),
  ...(config.sharedBranch !== undefined ? { sharedBranch: config.sharedBranch } : {}),
});
const gatewayState = new GatewayStateStore(config.stateDirectory);
let stopping = false;
let healthy = false;

/**
 * Drive one plain runner-claim request. Unlike `ovld runner once`, this gateway
 * never asks the CLI to spawn an agent locally: it launches an ACP session in a
 * Racecar sandbox through the shim adapter instead.
 */
async function runOnce(): Promise<void> {
  const claim = await runnerPost<RunnerClaimResponse>('/api/runner/claim', {});
  if (claim.request === undefined) return;
  const request = claim.request;
  await runnerPost(`/api/runner/requests/${encodeURIComponent(request.id)}/launching`);
  let recorded = false;
  let sessionPersisted = false;
  try {
    const prepared = await launchAdapter.prepare(request);
    const integration: IntegrationTrigger = {
      workspaceDir: prepared.project.workspaceDir,
      branch: prepared.branch,
      resourceKey: prepared.resourceKey,
      missionId: request.missionId,
    };
    const reservation = await gatewayState.reserve({
      executionRequestId: request.id,
      missionId: request.missionId,
      projectName: prepared.project.name,
      resourceKey: prepared.resourceKey,
      branch: prepared.branch,
      workingDirectory: prepared.workspaceDir,
      sandboxId: prepared.sandbox.id,
    });
    recorded = true;
    sessionPersisted = reservation.record.acpSessionId !== undefined;
    if (reservation.record.state === 'completed') {
      await runnerPost(`/api/runner/requests/${encodeURIComponent(request.id)}/launched`);
      return;
    }
    if (reservation.record.state === 'failed') {
      throw new Error(
        reservation.record.failure ?? `execution request '${request.id}' previously failed`,
      );
    }

    const bridge = new OverlordProtocolBridge({
      config,
      claim: request,
      provider,
      stateDirectory: config.stateDirectory,
    });
    if (reservation.record.acpSessionId !== undefined) {
      const resumed = await launchAdapter.resume(
        prepared,
        reservation.record.acpSessionId,
        bridge.handlers(),
      );
      if (reservation.record.protocolSessionKey === undefined) {
        // The ACP session is already durable. Re-running attach here is safe for
        // the unprompted recovery fence and never opens another ACP session.
        await bridge.attach(resumed);
        await gatewayState.bindProtocolSession(request.id, requiredSessionKey(bridge, request.id));
      } else {
        await bridge.resume(resumed, reservation.record.protocolSessionKey);
      }
      if (resumed.summary.status === 'running') {
        void completeResumedTurn(
          request.id,
          bridge,
          integration,
          resumed.connection,
          resumed.sessionId,
        );
      } else if (resumed.summary.lastStopReason !== undefined) {
        void completeResumedTurn(
          request.id,
          bridge,
          integration,
          resumed.connection,
          resumed.sessionId,
        );
      } else {
        await gatewayState.markPrompted(request.id);
        const launch = launchAdapter.prompt(resumed);
        void completePromptedTurn(
          request.id,
          bridge,
          integration,
          launch.connection,
          launch.sessionId,
          launch.turn,
        );
      }
    } else {
      const opened = await launchAdapter.open(prepared, bridge.handlers());
      try {
        await gatewayState.bindAcpSession(request.id, opened.sessionId);
        sessionPersisted = true;
        // Attach before prompt so every ACP update belongs to the mission session.
        await bridge.attach(opened);
        await gatewayState.bindProtocolSession(request.id, requiredSessionKey(bridge, request.id));
        await gatewayState.markPrompted(request.id);
        const launch = launchAdapter.prompt(opened);
        void completePromptedTurn(
          request.id,
          bridge,
          integration,
          launch.connection,
          launch.sessionId,
          launch.turn,
        );
      } catch (error) {
        opened.connection.close();
        await opened.connection.closed.catch(() => {});
        throw error;
      }
    }
    await runnerPost(`/api/runner/requests/${encodeURIComponent(request.id)}/launched`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Once an ACP session is on disk it is recoverable. Preserve that mapping
    // even if this process loses its connection after claiming the request.
    if (recorded && !sessionPersisted)
      await gatewayState.markFailed(request.id, message).catch(() => {});
    await runnerPost(`/api/runner/requests/${encodeURIComponent(request.id)}/failed`, {
      error: message,
    } satisfies RunnerFailureBody);
    throw error;
  }
}

function requiredSessionKey(bridge: OverlordProtocolBridge, requestId: string): string {
  if (bridge.sessionKey === undefined) {
    throw new Error(`ovld attach for execution request '${requestId}' returned no session key`);
  }
  return bridge.sessionKey;
}

/** Finish a new prompt, retaining the shim's own Git summary for delivery. */
async function completePromptedTurn(
  requestId: string,
  bridge: OverlordProtocolBridge,
  integration: IntegrationTrigger,
  connection: Awaited<ReturnType<typeof launchAdapter.open>>['connection'],
  sessionId: string,
  turn: Promise<PromptResponse>,
): Promise<void> {
  try {
    const outcome = await turn;
    const summary = await findSession(connection.client.listSessions(), sessionId);
    await completeTurn(requestId, bridge, integration, {
      ...summary,
      sessionId,
      status: 'idle',
      lastStopReason: outcome.stopReason,
    });
  } finally {
    connection.close();
    await connection.closed.catch(() => {});
  }
}

/** Poll an already-running shim session after reconnecting to a crashed gateway. */
async function completeResumedTurn(
  requestId: string,
  bridge: OverlordProtocolBridge,
  integration: IntegrationTrigger,
  connection: Awaited<ReturnType<typeof launchAdapter.open>>['connection'],
  sessionId: string,
): Promise<void> {
  try {
    for (;;) {
      const summary = await findSession(connection.client.listSessions(), sessionId);
      if (summary.status !== 'running') {
        await completeTurn(requestId, bridge, integration, summary);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, config.pollMs));
    }
  } finally {
    connection.close();
    await connection.closed.catch(() => {});
  }
}

async function completeTurn(
  requestId: string,
  bridge: OverlordProtocolBridge,
  integration: IntegrationTrigger,
  summary: SessionSummary,
): Promise<void> {
  try {
    await bridge.flush();
    await bridge.deliver({
      stopReason: summary.lastStopReason ?? 'cancelled',
      ...(summary.gitStatus !== undefined ? { gitStatus: summary.gitStatus } : {}),
      ...(summary.gitDiffStat !== undefined ? { gitDiffStat: summary.gitDiffStat } : {}),
    });
    await gatewayState.markCompleted(requestId);
    // The mission delivered; advance the merge-to-main queue now rather than on
    // a timer, since `ovld` and the `racecar` CLI share this process.
    await triggerIntegration(integration);
  } catch (error) {
    process.stderr.write(`gateway: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Context a delivered turn needs to advance its resource's integration queue. */
interface IntegrationTrigger {
  /** Gateway-host repo that owns this project's `.racecar/integration/` queue. */
  readonly workspaceDir: string;
  readonly branch: string;
  readonly resourceKey: string;
  readonly missionId: string;
}

/**
 * Fire the git-native merge-to-main queue after a successful deliver. This only
 * re-homes the trigger — the queue itself (packages/core/src/integration, driven
 * by `racecar integration`) is untouched. Best-effort by design: the queue is the
 * source of truth and its own compare-and-swap guards correctness, so a failure
 * here is logged, never fatal, and never undoes an already-delivered turn.
 */
async function triggerIntegration(trigger: IntegrationTrigger): Promise<void> {
  try {
    await runRacecar(
      [
        'integration',
        'enqueue',
        '--mission',
        trigger.missionId,
        '--head',
        trigger.branch,
        '--branch',
        trigger.branch,
        '--resource',
        trigger.resourceKey,
        '--json',
      ],
      trigger.workspaceDir,
    );
    await runRacecar(
      ['integration', 'run', '--once', '--resource', trigger.resourceKey, '--json'],
      trigger.workspaceDir,
    );
  } catch (error) {
    process.stderr.write(
      `gateway integration: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** Run the co-installed `racecar` CLI as a subprocess, mirroring the `ovld` shell-out. */
async function runRacecar(args: readonly string[], cwd: string): Promise<void> {
  await execFileAsync('racecar', [...args], { cwd, maxBuffer: 4 * 1024 * 1024 });
}

async function findSession(
  sessions: Promise<readonly SessionSummary[]>,
  sessionId: string,
): Promise<SessionSummary> {
  const summary = (await sessions).find((session) => session.sessionId === sessionId);
  if (summary === undefined)
    throw new Error(`shim session '${sessionId}' disappeared during gateway recovery`);
  return summary;
}

/** Minimal, versioned runner REST consumer; all other lifecycle calls stay ovld subprocesses. */
async function runnerRequest<T = unknown>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${config.backendUrl}${path}`, {
    method,
    headers: {
      accept: 'application/json',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      authorization: `Bearer ${config.token}`,
      'x-overlord-device-fingerprint': config.deviceFingerprint,
      'x-overlord-device-label': config.instanceId,
      'x-overlord-device-platform': 'racecar-gateway',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail =
      typeof payload === 'object' && payload !== null && 'error' in payload
        ? String(payload.error)
        : `runner request failed: ${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return payload as T;
}

const runnerPost = <T = unknown>(path: string, body?: unknown): Promise<T> =>
  runnerRequest<T>('POST', path, body);
const runnerGet = <T = unknown>(path: string): Promise<T> => runnerRequest<T>('GET', path);

const server = createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: healthy, instanceId: config.instanceId }));
    return;
  }
  response.writeHead(404).end();
});
server.listen(config.port);

const shutdown = (): void => {
  stopping = true;
  server.close();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const logError = (error: unknown): void => {
  process.stderr.write(`gateway: ${error instanceof Error ? error.message : String(error)}\n`);
};

/** Claims and drives queued work; health tracks this, the gateway's core job. */
async function claimLoop(): Promise<void> {
  while (!stopping) {
    try {
      await runOnce();
      healthy = true;
    } catch (error) {
      healthy = false;
      logError(error);
    }
    if (stopping) break;
    await delay(config.pollMs);
  }
}

/**
 * Resumes stopped/archived sandboxes for missions with queued work, so a claim
 * never has to drive a slow restore inline. Runs independently of the claim
 * loop and never affects health — pre-warming is an optimization, not the
 * gateway's core function.
 */
async function wakeLoop(): Promise<void> {
  const waker = new SandboxWaker({
    adapter: launchAdapter,
    fetchStatus: () => runnerGet<RunnerQueueStatus>('/api/runner/status'),
    log: (message) => process.stderr.write(`gateway waker: ${message}\n`),
  });
  while (!stopping) {
    try {
      await waker.tick();
    } catch (error) {
      logError(error);
    }
    if (stopping) break;
    await delay(config.pollMs);
  }
}

/**
 * Fail fast (or at least log loudly) if the state directory cannot survive a
 * redeploy, before any work is claimed. A wiped state directory silently
 * re-claims already-claimed Overlord work and loses the `.racecar`
 * project/Overlord state, so this runs ahead of the claim loop.
 */
const durability = await ensureDurableStateDir({
  stateDirectory: config.stateDirectory,
  deviceFingerprint: config.deviceFingerprint,
  instanceId: config.instanceId,
  now: () => new Date(),
});
process.stderr.write(`${describeDurability(durability)}\n`);
for (const warning of durability.warnings) process.stderr.write(`gateway: ${warning}\n`);

await Promise.all([claimLoop(), wakeLoop()]);
