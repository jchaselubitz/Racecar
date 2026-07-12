import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { OverlordClient } from './client.js';
import { loadConfig } from './config.js';
import type { VirtualExecutionQueueItemV1 } from './overlord-contract.js';
const exec = promisify(execFile);
const config = loadConfig();
const client = new OverlordClient(config.backendUrl, config.token);
let healthy = false;
let stopping = false;
const now = () => new Date().toISOString();
async function run(
  command: string,
  cwd?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await exec('sh', ['-c', command], { cwd, env, maxBuffer: 1024 * 1024 });
}
async function launch(item: VirtualExecutionQueueItemV1, claimId: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'racecar-gateway-'));
  const file = join(dir, 'request.json');
  try {
    await writeFile(file, `${JSON.stringify(item)}\n`);
    await client.progress(item.executionRequestId, {
      claimId,
      sequence: 1,
      stage: 'materializing',
      message: 'Racecar gateway accepted request',
      percent: 5,
      observedAt: now(),
    });
    await run(config.launchCommand, undefined, {
      ...process.env,
      RACECAR_GATEWAY_REQUEST_FILE: file,
      RACECAR_GATEWAY_CLAIM_ID: claimId,
    });
    await client.launched(item.executionRequestId, {
      claimId,
      sequence: 2,
      payloadDigest: item.payloadDigest,
      externalRunId: item.executionRequestId,
      observedAt: now(),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function tick(): Promise<void> {
  await client.register({
    executionTargetId: config.executionTargetId,
    gatewayKey: 'racecar',
    gatewayInstanceId: config.instanceId,
    gatewayVersion: '0.0.0',
    capabilities: { localCheckoutSource: false, sourceBundleSource: false, browserTerminal: false },
    supportedAgents: ['claude', 'codex'],
    supportedQueueVersions: ['v1'],
    connection: { deployment: 'racecar-gateway' },
  });
  healthy = true;
  if (config.integrationRepo)
    await run('racecar integration run --once', config.integrationRepo).catch(() => undefined);
  const claim = await client.claim(config.executionTargetId, config.instanceId);
  if (claim === null) return;
  try {
    await launch(claim.queueItem, claim.claimId);
  } catch (error) {
    await client.failed(claim.queueItem.executionRequestId, {
      claimId: claim.claimId,
      sequence: 99,
      failureCode: 'racecar:launch_failed',
      failurePhase: 'launch',
      retryable: true,
      message: error instanceof Error ? error.message.slice(0, 512) : 'launch failed',
      observedAt: now(),
    });
  }
}
createServer((request, response) => {
  if (request.url === '/healthz') {
    response.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: healthy, instanceId: config.instanceId }));
    return;
  }
  response.writeHead(404).end();
}).listen(config.port);
process.on('SIGTERM', () => {
  stopping = true;
});
process.on('SIGINT', () => {
  stopping = true;
});
while (!stopping) {
  try {
    await tick();
  } catch (error) {
    healthy = false;
    process.stderr.write(`gateway: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, config.pollMs));
}
