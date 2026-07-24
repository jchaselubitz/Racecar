import { execFile as execFileCallback, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type {
  AcpClientHandlers,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
  SessionUpdateNotification,
  StopReason,
} from '@racecar/shim';
import type { GatewayConfig } from './config.js';
import type { OpenShimLaunch, RunnerClaim } from './launch-adapter.js';
import type { SandboxProvider } from '@racecar/core';

const execFile = promisify(execFileCallback);

/** The only ACP events that need a durable Overlord progress event. */
export function protocolEventForUpdate(
  update: SessionUpdate,
): { command: 'update' | 'heartbeat' | 'ask'; text: string } | undefined {
  if (update.sessionUpdate === 'agent_question') {
    const question = update.question.trim();
    return question.length === 0 ? undefined : { command: 'ask', text: question };
  }
  if (update.sessionUpdate !== 'tool_call') return undefined;
  switch (update.status) {
    case 'pending':
    case 'in_progress':
      return {
        command: 'update',
        text: `Agent ${update.status.replace('_', ' ')} tool: ${update.title}`,
      };
    case 'completed':
      return { command: 'heartbeat', text: `Agent completed tool: ${update.title}` };
    case 'failed':
      return { command: 'update', text: `Agent tool failed: ${update.title}` };
  }
}

/** Auto-approve the same isolated-sandbox permission options as `racecar run`. */
export function autoApprovePermission(
  request: RequestPermissionRequest,
): RequestPermissionResponse {
  const option = request.options.find(
    (candidate) => candidate.kind === 'allow_once' || candidate.kind === 'allow_always',
  );
  return option === undefined
    ? { outcome: { outcome: 'cancelled' } }
    : { outcome: { outcome: 'selected', optionId: option.optionId } };
}

/**
 * Gateway-owned adapter between an ACP shim session and the documented `ovld
 * protocol` subprocess contract. Calls are serialized so streamed tool state
 * remains ordered even when the shim emits updates quickly.
 */
export class OverlordProtocolBridge {
  readonly #config: GatewayConfig;
  readonly #claim: RunnerClaim;
  readonly #provider: SandboxProvider;
  readonly #stateDirectory: string;
  #sessionKey: string | undefined;
  #checkpointWorktree: string | undefined;
  #sandboxId: string | undefined;
  #workspaceDir: string | undefined;
  readonly #recordedPaths = new Set<string>();
  #tail: Promise<void> = Promise.resolve();
  /** `ask` is terminal for the protocol session; discard later turn telemetry. */
  #asked = false;

  constructor(options: {
    config: GatewayConfig;
    claim: RunnerClaim;
    provider: SandboxProvider;
    stateDirectory?: string;
  }) {
    this.#config = options.config;
    this.#claim = options.claim;
    this.#provider = options.provider;
    this.#stateDirectory = options.stateDirectory ?? process.cwd();
  }

  /** ACP handlers passed when opening the shim session. */
  handlers(): AcpClientHandlers {
    return {
      onUpdate: (notification) => this.#onUpdate(notification),
      onPermission: (request) => this.#onPermission(request),
    };
  }

  /**
   * Create the Overlord session before prompting the sandbox agent. The command
   * runs in a per-request worktree backed by a gateway mirror, giving attach its
   * required checkpoint ref without depending on the sandbox filesystem.
   */
  async attach(opened: OpenShimLaunch): Promise<void> {
    const cwd = await this.#prepareCheckpointWorktree(opened);
    this.#checkpointWorktree = cwd;
    this.#sandboxId = opened.sandbox.id;
    this.#workspaceDir = opened.workspaceDir;
    const output = await this.#invoke(
      [
        'protocol',
        'attach',
        '--mission-id',
        this.#claim.missionId,
        '--execution-request-id',
        this.#claim.id,
        '--external-session-id',
        opened.sessionId,
      ],
      cwd,
    );
    this.#sessionKey = sessionKeyFromAttach(output);
  }

  /** Rebind a gateway process to an already-attached ACP/protocol pairing. */
  async resume(opened: OpenShimLaunch, sessionKey: string): Promise<void> {
    this.#checkpointWorktree = await this.#prepareCheckpointWorktree(opened);
    this.#sandboxId = opened.sandbox.id;
    this.#workspaceDir = opened.workspaceDir;
    this.#sessionKey = sessionKey;
  }

  /** Persist this immediately after a successful attach, before prompting ACP. */
  get sessionKey(): string | undefined {
    return this.#sessionKey;
  }

  /** Wait for all already-enqueued protocol telemetry to finish. */
  async flush(): Promise<void> {
    await this.#tail;
  }

  /**
   * Deliver the completed ACP turn. The shim's turn-end Git summary is the
   * authority here: delivery deliberately runs outside the checkpoint worktree
   * so `ovld` cannot merge in a potentially stale gateway-mirror diff.
   */
  async deliver(summary: {
    readonly stopReason: StopReason;
    readonly gitStatus?: string;
    readonly gitDiffStat?: string;
  }): Promise<void> {
    if (this.#sessionKey === undefined || this.#asked) return;
    const changedFiles = changedFilesFromShimGitStatus(summary.gitStatus ?? '');
    const artifacts =
      summary.gitDiffStat !== undefined && summary.gitDiffStat.trim().length > 0
        ? [
            {
              type: 'note',
              label: 'Shim git diff stat',
              content: summary.gitDiffStat,
            },
          ]
        : [];
    const deliveryCwd = await mkdtemp(join(tmpdir(), 'racecar-overlord-deliver-'));
    try {
      await this.#invoke(
        [
          'protocol',
          'deliver',
          '--summary',
          deliverySummary(summary.stopReason, changedFiles.length),
          '--artifacts-json',
          JSON.stringify(artifacts),
          // Deliver runs in a throwaway cwd with no VCS baseline, so the CLI's
          // mechanical delta is empty; the shim's turn-end status is authority.
          // Every reported change needs a rationale or deliver rejects with
          // missing_rationale, so synthesize one per file; assert no-change
          // explicitly when the shim saw nothing dirty.
          ...(changedFiles.length === 0
            ? ['--no-file-changes']
            : [
                '--changed-files-json',
                JSON.stringify(changedFiles),
                '--change-rationales-json',
                JSON.stringify(
                  changeRationalesForChangedFiles(changedFiles, this.#claim.missionId),
                ),
              ]),
        ],
        deliveryCwd,
      );
    } finally {
      await rm(deliveryCwd, { recursive: true, force: true });
    }
  }

  #onUpdate(notification: SessionUpdateNotification): void {
    const event = protocolEventForUpdate(notification.update);
    if (event === undefined) return;
    if (this.#asked) return;
    if (event.command === 'ask') this.#asked = true;
    this.#enqueue(async () => {
      if (
        notification.update.sessionUpdate === 'tool_call' &&
        notification.update.status === 'completed'
      ) {
        await this.#captureTouchedFiles();
      }
      if (event.command === 'update') await this.#update(event.text);
      else if (event.command === 'heartbeat') await this.#heartbeat(event.text);
      else await this.#ask(event.text);
    });
  }

  #onPermission(request: RequestPermissionRequest): RequestPermissionResponse {
    if (!this.#asked) {
      this.#enqueue(() => this.#permissionEvent(request.toolCall.title));
    }
    return autoApprovePermission(request);
  }

  #enqueue(operation: () => Promise<void>): void {
    this.#tail = this.#tail.then(operation, operation).catch((error: unknown) => {
      process.stderr.write(
        `gateway protocol bridge: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    });
  }

  async #update(summary: string): Promise<void> {
    await this.#protocol(['update', '--summary', summary, '--phase', 'execute']);
  }

  async #heartbeat(note: string): Promise<void> {
    await this.#protocol(['heartbeat', '--phase', 'execute', '--note', note]);
  }

  /** Ask moves the mission to review, so no delivery or later update may follow. */
  async #ask(question: string): Promise<void> {
    await this.#protocol(['ask', '--question', question]);
  }

  /**
   * Reconstruct the sandbox's auto-approved permission request as a mission
   * alert. `ovld protocol hook-event` only accepts `UserPromptSubmit`, so the
   * permission fidelity an installed connector hook would normally post is
   * emitted here as an `alert`-typed update instead.
   */
  async #permissionEvent(prompt: string): Promise<void> {
    await this.#protocol([
      'update',
      '--summary',
      `Auto-approved sandbox permission request: ${prompt}`,
      '--phase',
      'execute',
      '--event-type',
      'alert',
    ]);
  }

  async #protocol(args: readonly string[]): Promise<void> {
    if (this.#sessionKey === undefined) return;
    await this.#invoke(
      [
        'protocol',
        ...args,
        '--mission-id',
        this.#claim.missionId,
        '--session-key',
        this.#sessionKey,
      ],
      this.#checkpointWorktree ?? this.#stateDirectory,
    );
  }

  /**
   * ACP tells us exactly when a tool completed but not which files it edited.
   * At that boundary, inspect the sandbox's own workspace (never the gateway
   * mirror) and write newly dirty paths through the normal PostToolUse log
   * command in the checkpoint worktree. This keeps edit attribution tied to the
   * real sandbox while preserving the protocol CLI's session bookkeeping.
   */
  async #captureTouchedFiles(): Promise<void> {
    if (
      this.#sandboxId === undefined ||
      this.#workspaceDir === undefined ||
      this.#checkpointWorktree === undefined
    )
      return;
    const result = await this.#provider.exec(this.#sandboxId, {
      command: 'git status --porcelain=v1 -z',
      cwd: this.#workspaceDir,
      timeoutSeconds: 15,
    });
    if (result.exitCode !== 0) throw new Error(`cannot capture sandbox edits: ${result.output}`);
    const paths = porcelainPaths(result.output).filter((path) => !this.#recordedPaths.has(path));
    if (paths.length === 0) return;
    for (const path of paths) this.#recordedPaths.add(path);
    const payload = JSON.stringify({
      tool_name: 'ACP tool call',
      cwd: this.#checkpointWorktree,
      tool_input: { edits: paths.map((file_path) => ({ file_path })) },
    });
    await this.#invokeWithStdin(
      ['protocol', 'record-touched', '--mission-id', this.#claim.missionId],
      this.#checkpointWorktree,
      payload,
    );
  }

  async #prepareCheckpointWorktree(opened: OpenShimLaunch): Promise<string> {
    const root = join(this.#stateDirectory, '.racecar', 'gateway-mirrors', opened.project.name);
    const mirror = join(root, 'repository.git');
    const worktree = join(root, 'worktrees', this.#claim.id);
    await mkdir(join(root, 'worktrees'), { recursive: true });
    try {
      await this.#git(['clone', '--mirror', opened.project.workspaceDir, mirror], root);
    } catch {
      await this.#git(['-C', mirror, 'fetch', '--prune', 'origin'], root);
    }
    await this.#git(['-C', mirror, 'fetch', 'origin', opened.branch], root);
    try {
      await access(worktree);
    } catch {
      await this.#git(
        ['--git-dir', mirror, 'worktree', 'add', '--force', '--detach', worktree, 'FETCH_HEAD'],
        root,
      );
    }
    return worktree;
  }

  async #git(args: readonly string[], cwd: string): Promise<void> {
    await execFile('git', [...args], { cwd, maxBuffer: 1024 * 1024 });
  }

  /** Backend URL, token, and pinned fingerprint every `ovld` child inherits. */
  #childEnv(): NodeJS.ProcessEnv {
    return {
      ...process.env,
      OVERLORD_BACKEND_URL: this.#config.backendUrl,
      OVERLORD_USER_TOKEN: this.#config.token,
      OVERLORD_DEVICE_FINGERPRINT: this.#config.deviceFingerprint,
    };
  }

  async #invoke(args: readonly string[], cwd: string): Promise<string> {
    const { stdout } = await execFile('ovld', [...args], {
      cwd,
      maxBuffer: 4 * 1024 * 1024,
      env: this.#childEnv(),
    });
    return stdout;
  }

  async #invokeWithStdin(args: readonly string[], cwd: string, input: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ovld', [...args], {
        cwd,
        env: this.#childEnv(),
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ovld ${args.join(' ')} failed: ${stderr.trim()}`));
      });
      child.stdin.end(input);
    });
  }
}

/** Extract current paths from a porcelain-v1 NUL-delimited status stream. */
export function porcelainPaths(output: string): string[] {
  const entries = output.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || entry.length < 4) continue;
    const status = entry.slice(0, 2);
    paths.push(entry.slice(3));
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C')
      index += 1;
  }
  return paths;
}

/** Turn the shim's line-oriented `git status --porcelain` snapshot into protocol entries. */
export function changedFilesFromShimGitStatus(
  gitStatus: string,
): Array<{ filePath: string; vcsStatus: string }> {
  const files: Array<{ filePath: string; vcsStatus: string }> = [];
  for (const line of gitStatus.split('\n')) {
    if (line.length < 4 || line.startsWith('!!')) continue;
    const filePath = line.slice(3);
    if (filePath.length === 0) continue;
    files.push({ filePath, vcsStatus: line.slice(0, 2) });
  }
  return files;
}

/** One `ProtocolChangeRationale` per changed file. */
export interface ProtocolChangeRationale {
  readonly file_path: string;
  readonly label: string;
  readonly summary: string;
  readonly why: string;
  readonly impact: string;
}

/**
 * Synthesize a minimal, truthful rationale for each file the shim reported
 * changed. The gateway drives the agent remotely and never inspects the diff
 * itself, so these describe provenance (which mission changed the file, and its
 * VCS status) rather than inventing intent the gateway cannot know.
 */
export function changeRationalesForChangedFiles(
  changedFiles: ReadonlyArray<{ filePath: string; vcsStatus: string }>,
  missionId: string,
): ProtocolChangeRationale[] {
  return changedFiles.map((file) => ({
    file_path: file.filePath,
    label: `Agent edit (${file.vcsStatus.trim()})`,
    summary: `Changed by the sandbox agent during this turn (git status '${file.vcsStatus.trim()}').`,
    why: `Produced while executing Overlord mission ${missionId} in the Racecar sandbox.`,
    impact: 'Applied to the sandbox working tree; captured from the shim turn-end git status.',
  }));
}

/** A concise terminal narrative; detailed changed-file state lives in the protocol payload. */
export function deliverySummary(stopReason: StopReason, changedFileCount: number): string {
  return `Gateway-delivered ACP turn after ${stopReason}; shim captured ${changedFileCount} changed file${changedFileCount === 1 ? '' : 's'}.`;
}

function sessionKeyFromAttach(output: string): string {
  const key = /^SESSION_KEY=(.+)$/m.exec(output)?.[1]?.trim();
  if (key !== undefined && key.length > 0) return key;
  const jsonStart = output.indexOf('{');
  if (jsonStart >= 0) {
    const parsed: unknown = JSON.parse(output.slice(jsonStart));
    if (typeof parsed === 'object' && parsed !== null) {
      const direct = (parsed as { sessionKey?: unknown }).sessionKey;
      const nested = (parsed as { session?: { sessionKey?: unknown } }).session?.sessionKey;
      if (typeof direct === 'string') return direct;
      if (typeof nested === 'string') return nested;
    }
  }
  throw new Error('ovld protocol attach did not return a session key');
}
