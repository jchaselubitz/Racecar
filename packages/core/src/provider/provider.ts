/**
 * The provider adapter interface: everything the Racecar control plane needs
 * from a sandbox provider, expressed in provider-neutral terms. Daytona is the
 * only implementation for v1, but the boundary keeps a second provider a matter
 * of writing one class, not touching the control plane.
 */

/**
 * Normalized sandbox runtime state. Providers map their (often larger) set of
 * states onto these; `unknown` is the escape hatch for anything unrecognized.
 */
export type SandboxRuntimeState =
  | 'starting'
  | 'started'
  | 'stopping'
  | 'stopped'
  | 'archiving'
  | 'archived'
  | 'destroying'
  | 'destroyed'
  | 'error'
  | 'unknown';

/** Normalized snapshot state. */
export type ProviderSnapshotState = 'building' | 'active' | 'error' | 'unknown';

/**
 * Provider-neutral view of a sandbox as returned by the adapter. This is a
 * plain descriptor, not a live handle: operations take an id and go back
 * through the provider, which keeps the interface trivially fakeable.
 */
export interface ProviderSandbox {
  readonly id: string;
  readonly state: SandboxRuntimeState;
  readonly labels: Record<string, string>;
  readonly snapshot?: string;
  readonly createdAt?: string;
  readonly lastActivityAt?: string;
  readonly autoStopMinutes?: number;
  readonly autoArchiveMinutes?: number;
  readonly autoDeleteMinutes?: number;
  readonly errorReason?: string;
}

/** Provider-neutral view of a snapshot. */
export interface ProviderSnapshot {
  readonly name: string;
  readonly state: ProviderSnapshotState;
  readonly imageName?: string;
}

/** Request to build a snapshot from a base image plus setup commands. */
export interface SnapshotBuildRequest {
  readonly name: string;
  readonly baseImage: string;
  readonly setupCommands?: readonly string[];
  readonly workdir?: string;
  readonly envVars?: Record<string, string>;
  /** Called with build log chunks as they stream from the provider. */
  readonly onLog?: (chunk: string) => void;
}

/** Request to create a sandbox from an existing snapshot. */
export interface CreateSandboxRequest {
  readonly snapshot: string;
  readonly name?: string;
  readonly labels?: Record<string, string>;
  readonly envVars?: Record<string, string>;
  readonly autoStopMinutes?: number;
  readonly autoArchiveMinutes?: number;
  readonly autoDeleteMinutes?: number;
  readonly public?: boolean;
  /** Provider create timeout in seconds. */
  readonly timeoutSeconds?: number;
}

/** Filter for listing sandboxes. */
export interface ListSandboxesFilter {
  /** Match sandboxes carrying all of these labels. */
  readonly labels?: Record<string, string>;
  /** Restrict to these runtime states (applied after normalization). */
  readonly states?: readonly SandboxRuntimeState[];
}

/** A command to run inside a sandbox. */
export interface ExecRequest {
  readonly command: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  /** Command timeout in seconds. */
  readonly timeoutSeconds?: number;
}

/** Result of an {@link ExecRequest}. */
export interface ExecResult {
  readonly exitCode: number;
  readonly output: string;
}

/** Request to open an interactive PTY session inside a sandbox. */
export interface PtyRequest {
  /** Caller-chosen PTY session id, unique within the sandbox. */
  readonly id: string;
  readonly cwd?: string;
  readonly env?: Record<string, string>;
  readonly cols?: number;
  readonly rows?: number;
  /** Receives raw output bytes from the PTY as they arrive. */
  readonly onData: (data: Uint8Array) => void | Promise<void>;
}

/** How a PTY session ended. */
export interface PtyExit {
  readonly exitCode?: number;
  readonly error?: string;
}

/**
 * A live handle to a PTY session. Abstracts the provider's PTY object so the
 * control plane can attach/detach, resize, and stream without SDK types.
 */
export interface ProviderPty {
  readonly sessionId: string;
  /** Send input (keystrokes or bytes) to the PTY. */
  sendInput(data: string | Uint8Array): Promise<void>;
  /** Resize the terminal. */
  resize(cols: number, rows: number): Promise<void>;
  /** Resolve once the PTY process exits. */
  wait(): Promise<PtyExit>;
  /** Forcefully terminate the PTY process. */
  kill(): Promise<void>;
  /** Close the connection and release resources without killing the process. */
  disconnect(): Promise<void>;
}

/** A preview URL exposing a port served from inside the sandbox. */
export interface PreviewUrl {
  readonly url: string;
  /** Access token for private sandboxes, when the provider issues one. */
  readonly token?: string;
}

/**
 * The sandbox provider adapter. One implementation per provider; Daytona is the
 * only one in v1. Every method throws a {@link ProviderError} subclass on
 * failure, and the `get*` methods return `null` for a missing resource rather
 * than throwing.
 */
export interface SandboxProvider {
  /** Short provider identifier, e.g. `"daytona"`. */
  readonly name: string;

  // --- snapshots ---
  buildSnapshot(request: SnapshotBuildRequest): Promise<ProviderSnapshot>;
  getSnapshot(name: string): Promise<ProviderSnapshot | null>;
  deleteSnapshot(name: string): Promise<void>;

  // --- lifecycle ---
  createSandbox(request: CreateSandboxRequest): Promise<ProviderSandbox>;
  getSandbox(id: string): Promise<ProviderSandbox | null>;
  listSandboxes(filter?: ListSandboxesFilter): Promise<ProviderSandbox[]>;
  startSandbox(id: string, timeoutSeconds?: number): Promise<void>;
  stopSandbox(id: string, timeoutSeconds?: number): Promise<void>;
  archiveSandbox(id: string): Promise<void>;
  deleteSandbox(id: string): Promise<void>;

  // --- labels & activity ---
  setLabels(id: string, labels: Record<string, string>): Promise<Record<string, string>>;
  /** Refresh the sandbox's activity timer to keep it alive (heartbeat). */
  heartbeat(id: string): Promise<void>;

  // --- exec, PTY, preview ---
  exec(id: string, request: ExecRequest): Promise<ExecResult>;
  createPty(id: string, request: PtyRequest): Promise<ProviderPty>;
  getPreviewUrl(id: string, port: number): Promise<PreviewUrl>;
}
