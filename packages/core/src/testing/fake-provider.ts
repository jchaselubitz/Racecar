/*
 * This is an in-memory test double that implements the async SandboxProvider
 * interface synchronously, so most methods legitimately have no `await`.
 */
/* eslint-disable @typescript-eslint/require-await */
import { ProviderConflictError, ProviderNotFoundError } from '../provider/errors.js';
import type {
  CreateSandboxRequest,
  ExecRequest,
  ExecResult,
  ListSandboxesFilter,
  PreviewUrl,
  ProviderPty,
  ProviderSandbox,
  ProviderSnapshot,
  PtyExit,
  PtyRequest,
  SandboxProvider,
  SandboxRuntimeState,
  SnapshotBuildRequest,
} from '../provider/provider.js';

/** A handler that produces a canned {@link ExecResult} for an exec request. */
export type FakeExecHandler = (
  id: string,
  request: ExecRequest,
) => ExecResult | Promise<ExecResult>;

/** Options controlling the fake provider's determinism. */
export interface FakeProviderOptions {
  /** Clock used for timestamps. Defaults to `() => new Date()`. */
  readonly now?: () => Date;
  /** Prefix for generated sandbox ids. Defaults to `"sbx"`. */
  readonly idPrefix?: string;
  /** Custom exec behavior; defaults to a zero-exit, empty-output result. */
  readonly execHandler?: FakeExecHandler;
}

interface StoredSandbox {
  id: string;
  state: SandboxRuntimeState;
  labels: Record<string, string>;
  snapshot: string;
  createdAt: string;
  lastActivityAt: string;
  autoStopMinutes?: number;
  autoArchiveMinutes?: number;
  autoDeleteMinutes?: number;
}

function labelsMatch(labels: Record<string, string>, filter: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    if (labels[key] !== value) return false;
  }
  return true;
}

/**
 * A PTY test double. Records everything sent to it and lets tests drive its
 * output and exit. Useful for exercising attach/detach and streaming logic
 * without a live sandbox.
 */
export class FakePty implements ProviderPty {
  readonly sessionId: string;
  /** Every input passed to {@link sendInput}, in order. */
  readonly inputs: (string | Uint8Array)[] = [];
  /** Last size passed to {@link resize}, if any. */
  resizedTo: { cols: number; rows: number } | undefined;
  killed = false;
  disconnected = false;

  private readonly onData: (data: Uint8Array) => void | Promise<void>;
  private exit: PtyExit;
  private waiters: ((exit: PtyExit) => void)[] = [];
  private exited = false;

  constructor(request: PtyRequest, exit: PtyExit = { exitCode: 0 }) {
    this.sessionId = request.id;
    this.onData = request.onData;
    this.exit = exit;
  }

  /** Simulate the PTY emitting output to its `onData` callback. */
  async emit(data: string | Uint8Array): Promise<void> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    await this.onData(bytes);
  }

  /** Simulate the PTY process exiting, resolving any pending {@link wait}. */
  finish(exit: PtyExit = { exitCode: 0 }): void {
    this.exit = exit;
    this.exited = true;
    for (const resolve of this.waiters) resolve(exit);
    this.waiters = [];
  }

  async sendInput(data: string | Uint8Array): Promise<void> {
    this.inputs.push(data);
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.resizedTo = { cols, rows };
  }

  wait(): Promise<PtyExit> {
    if (this.exited) return Promise.resolve(this.exit);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async kill(): Promise<void> {
    this.killed = true;
    this.finish({ exitCode: 137 });
  }

  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

/**
 * An in-memory {@link SandboxProvider} for tests. It models snapshot and
 * sandbox state and lifecycle transitions (including archive-requires-stopped)
 * so control-plane logic can be exercised deterministically with no network.
 */
export class FakeSandboxProvider implements SandboxProvider {
  readonly name = 'fake';

  /** Created PTY handles, so tests can drive them after `createPty`. */
  readonly ptys: FakePty[] = [];

  private readonly snapshots = new Map<string, ProviderSnapshot>();
  private readonly sandboxes = new Map<string, StoredSandbox>();
  private readonly now: () => Date;
  private readonly idPrefix: string;
  private readonly execHandler: FakeExecHandler;
  private counter = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.idPrefix = options.idPrefix ?? 'sbx';
    this.execHandler = options.execHandler ?? (() => ({ exitCode: 0, output: '' }));
  }

  private timestamp(): string {
    return this.now().toISOString();
  }

  private require(id: string): StoredSandbox {
    const sb = this.sandboxes.get(id);
    if (sb === undefined) {
      throw new ProviderNotFoundError(`sandbox not found: ${id}`);
    }
    return sb;
  }

  private view(sb: StoredSandbox): ProviderSandbox {
    return {
      id: sb.id,
      state: sb.state,
      labels: { ...sb.labels },
      snapshot: sb.snapshot,
      createdAt: sb.createdAt,
      lastActivityAt: sb.lastActivityAt,
      ...(sb.autoStopMinutes !== undefined ? { autoStopMinutes: sb.autoStopMinutes } : {}),
      ...(sb.autoArchiveMinutes !== undefined ? { autoArchiveMinutes: sb.autoArchiveMinutes } : {}),
      ...(sb.autoDeleteMinutes !== undefined ? { autoDeleteMinutes: sb.autoDeleteMinutes } : {}),
    };
  }

  // --- snapshots ---

  async buildSnapshot(request: SnapshotBuildRequest): Promise<ProviderSnapshot> {
    request.onLog?.(`building ${request.name} from ${request.baseImage}\n`);
    const snapshot: ProviderSnapshot = {
      name: request.name,
      state: 'active',
      imageName: `fake/${request.name}:latest`,
    };
    this.snapshots.set(request.name, snapshot);
    return snapshot;
  }

  async getSnapshot(name: string): Promise<ProviderSnapshot | null> {
    return this.snapshots.get(name) ?? null;
  }

  async deleteSnapshot(name: string): Promise<void> {
    if (!this.snapshots.delete(name)) {
      throw new ProviderNotFoundError(`snapshot not found: ${name}`);
    }
  }

  // --- lifecycle ---

  async createSandbox(request: CreateSandboxRequest): Promise<ProviderSandbox> {
    if (!this.snapshots.has(request.snapshot)) {
      throw new ProviderNotFoundError(`snapshot not found: ${request.snapshot}`);
    }
    const id = request.name ?? `${this.idPrefix}-${++this.counter}`;
    const ts = this.timestamp();
    const sb: StoredSandbox = {
      id,
      state: 'started',
      labels: { ...(request.labels ?? {}) },
      snapshot: request.snapshot,
      createdAt: ts,
      lastActivityAt: ts,
      ...(request.autoStopMinutes !== undefined
        ? { autoStopMinutes: request.autoStopMinutes }
        : {}),
      ...(request.autoArchiveMinutes !== undefined
        ? { autoArchiveMinutes: request.autoArchiveMinutes }
        : {}),
      ...(request.autoDeleteMinutes !== undefined
        ? { autoDeleteMinutes: request.autoDeleteMinutes }
        : {}),
    };
    this.sandboxes.set(id, sb);
    return this.view(sb);
  }

  async getSandbox(id: string): Promise<ProviderSandbox | null> {
    const sb = this.sandboxes.get(id);
    return sb === undefined ? null : this.view(sb);
  }

  async listSandboxes(filter?: ListSandboxesFilter): Promise<ProviderSandbox[]> {
    const result: ProviderSandbox[] = [];
    for (const sb of this.sandboxes.values()) {
      if (filter?.labels !== undefined && !labelsMatch(sb.labels, filter.labels)) continue;
      if (filter?.states !== undefined && !filter.states.includes(sb.state)) continue;
      result.push(this.view(sb));
    }
    return result;
  }

  async startSandbox(id: string): Promise<void> {
    const sb = this.require(id);
    sb.state = 'started';
    sb.lastActivityAt = this.timestamp();
  }

  async stopSandbox(id: string): Promise<void> {
    const sb = this.require(id);
    sb.state = 'stopped';
    sb.lastActivityAt = this.timestamp();
  }

  async archiveSandbox(id: string): Promise<void> {
    const sb = this.require(id);
    if (sb.state !== 'stopped' && sb.state !== 'archived') {
      throw new ProviderConflictError(
        `sandbox must be stopped before archiving (state=${sb.state})`,
      );
    }
    sb.state = 'archived';
  }

  async deleteSandbox(id: string): Promise<void> {
    this.require(id);
    this.sandboxes.delete(id);
  }

  // --- labels & activity ---

  async setLabels(id: string, labels: Record<string, string>): Promise<Record<string, string>> {
    const sb = this.require(id);
    sb.labels = { ...labels };
    return { ...sb.labels };
  }

  async heartbeat(id: string): Promise<void> {
    const sb = this.require(id);
    sb.lastActivityAt = this.timestamp();
  }

  // --- exec, PTY, preview ---

  async exec(id: string, request: ExecRequest): Promise<ExecResult> {
    const sb = this.require(id);
    sb.lastActivityAt = this.timestamp();
    return this.execHandler(id, request);
  }

  async createPty(id: string, request: PtyRequest): Promise<ProviderPty> {
    this.require(id);
    const pty = new FakePty(request);
    this.ptys.push(pty);
    return pty;
  }

  async getPreviewUrl(id: string, port: number): Promise<PreviewUrl> {
    this.require(id);
    return {
      url: `https://${port}-${id}.fake.local`,
      token: `token-${id}-${port}`,
    };
  }
}
