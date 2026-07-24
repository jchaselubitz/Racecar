import {
  Daytona,
  Image,
  SandboxState,
  DaytonaAuthenticationError,
  DaytonaAuthorizationError,
  DaytonaConflictError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
} from '@daytona/sdk';
import type { CreateSandboxFromSnapshotParams, Sandbox } from '@daytona/sdk';
import {
  ProviderError,
  ProviderNotFoundError,
  ProviderAuthError,
  ProviderConflictError,
  ProviderRateLimitError,
  ProviderTimeoutError,
} from './errors.js';
import type {
  CreateSandboxRequest,
  ExecRequest,
  ExecResult,
  ListSandboxesFilter,
  PreviewUrl,
  ProviderPty,
  ProviderSandbox,
  ProviderSnapshot,
  ProviderSnapshotState,
  PtyExit,
  PtyRequest,
  SandboxProvider,
  SandboxRuntimeState,
  SnapshotBuildRequest,
} from './provider.js';

/** Configuration for {@link DaytonaProvider}. */
export interface DaytonaProviderConfig {
  readonly apiKey: string;
  readonly apiUrl?: string;
  readonly organizationId?: string;
  readonly target?: string;
}

/** Map a Daytona sandbox state onto the normalized runtime state. */
export function mapSandboxState(state: SandboxState | undefined): SandboxRuntimeState {
  switch (state) {
    case SandboxState.STARTED:
      return 'started';
    case SandboxState.CREATING:
    case SandboxState.STARTING:
    case SandboxState.RESTORING:
    case SandboxState.PENDING_BUILD:
    case SandboxState.BUILDING_SNAPSHOT:
    case SandboxState.PULLING_SNAPSHOT:
    case SandboxState.RESUMING:
      return 'starting';
    case SandboxState.STOPPING:
    case SandboxState.PAUSING:
      return 'stopping';
    case SandboxState.STOPPED:
    case SandboxState.PAUSED:
      return 'stopped';
    case SandboxState.ARCHIVING:
      return 'archiving';
    case SandboxState.ARCHIVED:
      return 'archived';
    case SandboxState.DESTROYING:
      return 'destroying';
    case SandboxState.DESTROYED:
      return 'destroyed';
    case SandboxState.ERROR:
    case SandboxState.BUILD_FAILED:
      return 'error';
    default:
      return 'unknown';
  }
}

/** Map a Daytona snapshot state string onto the normalized snapshot state. */
export function mapSnapshotState(state: unknown): ProviderSnapshotState {
  const s = String(state).toLowerCase();
  if (s === 'active') return 'active';
  if (s === 'error' || s === 'build_failed') return 'error';
  if (s === 'building' || s === 'pending' || s.startsWith('pending')) return 'building';
  return 'unknown';
}

/** Translate a Daytona SDK error into the provider-neutral hierarchy. */
export function mapDaytonaError(error: unknown): ProviderError {
  if (error instanceof ProviderError) return error;
  if (error instanceof DaytonaNotFoundError) return new ProviderNotFoundError(error.message, error);
  if (error instanceof DaytonaAuthenticationError || error instanceof DaytonaAuthorizationError) {
    return new ProviderAuthError(error.message, error);
  }
  if (error instanceof DaytonaConflictError) return new ProviderConflictError(error.message, error);
  if (error instanceof DaytonaRateLimitError)
    return new ProviderRateLimitError(error.message, error);
  if (error instanceof DaytonaTimeoutError) return new ProviderTimeoutError(error.message, error);
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError(message, error);
}

function toProviderSandbox(sb: Sandbox): ProviderSandbox {
  return {
    id: sb.id,
    state: mapSandboxState(sb.state),
    labels: sb.labels ?? {},
    ...(sb.snapshot !== undefined ? { snapshot: sb.snapshot } : {}),
    ...(sb.createdAt !== undefined ? { createdAt: sb.createdAt } : {}),
    ...(sb.lastActivityAt !== undefined ? { lastActivityAt: sb.lastActivityAt } : {}),
    ...(sb.autoStopInterval !== undefined ? { autoStopMinutes: sb.autoStopInterval } : {}),
    ...(sb.autoArchiveInterval !== undefined ? { autoArchiveMinutes: sb.autoArchiveInterval } : {}),
    ...(sb.autoDeleteInterval !== undefined ? { autoDeleteMinutes: sb.autoDeleteInterval } : {}),
    ...(sb.errorReason !== undefined ? { errorReason: sb.errorReason } : {}),
  };
}

/** Structural view of the SDK's (non-exported) Snapshot class. */
interface DaytonaSnapshotLike {
  readonly name: string;
  readonly state?: unknown;
  readonly imageName?: string;
}

function toProviderSnapshot(snap: DaytonaSnapshotLike): ProviderSnapshot {
  return {
    name: snap.name,
    state: mapSnapshotState(snap.state),
    ...(snap.imageName !== undefined ? { imageName: snap.imageName } : {}),
  };
}

/**
 * Daytona implementation of {@link SandboxProvider}. Wraps `@daytona/sdk`,
 * mapping its sandbox/snapshot objects, PTY handles, and errors into the
 * provider-neutral shapes the control plane consumes.
 */
export class DaytonaProvider implements SandboxProvider {
  readonly name = 'daytona';
  private readonly daytona: Daytona;

  constructor(config: DaytonaProviderConfig) {
    this.daytona = new Daytona({
      apiKey: config.apiKey,
      ...(config.apiUrl !== undefined ? { apiUrl: config.apiUrl } : {}),
      ...(config.organizationId !== undefined ? { organizationId: config.organizationId } : {}),
      ...(config.target !== undefined ? { target: config.target } : {}),
    });
  }

  async buildSnapshot(request: SnapshotBuildRequest): Promise<ProviderSnapshot> {
    try {
      let image = Image.base(request.baseImage);
      if (request.envVars !== undefined && Object.keys(request.envVars).length > 0) {
        image = image.env(request.envVars);
      }
      if (request.setupCommands !== undefined && request.setupCommands.length > 0) {
        image = image.runCommands(...request.setupCommands);
      }
      if (request.workdir !== undefined) {
        image = image.workdir(request.workdir);
      }
      const onLogs = request.onLog;
      await this.daytona.snapshot.create(
        { name: request.name, image },
        onLogs !== undefined ? { onLogs } : undefined,
      );
      const snap = await this.daytona.snapshot.get(request.name);
      return toProviderSnapshot(snap);
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async getSnapshot(name: string): Promise<ProviderSnapshot | null> {
    try {
      const snap = await this.daytona.snapshot.get(name);
      return toProviderSnapshot(snap);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw mapDaytonaError(error);
    }
  }

  async deleteSnapshot(name: string): Promise<void> {
    try {
      const snap = await this.daytona.snapshot.get(name);
      await this.daytona.snapshot.delete(snap);
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async createSandbox(request: CreateSandboxRequest): Promise<ProviderSandbox> {
    try {
      const params: CreateSandboxFromSnapshotParams = {
        snapshot: request.snapshot,
        ...(request.name !== undefined ? { name: request.name } : {}),
        ...(request.labels !== undefined ? { labels: request.labels } : {}),
        ...(request.envVars !== undefined ? { envVars: request.envVars } : {}),
        ...(request.public !== undefined ? { public: request.public } : {}),
        ...(request.networkBlockAll !== undefined
          ? { networkBlockAll: request.networkBlockAll }
          : {}),
        ...(request.domainAllowList !== undefined
          ? { domainAllowList: request.domainAllowList.join(',') }
          : {}),
        ...(request.autoStopMinutes !== undefined
          ? { autoStopInterval: request.autoStopMinutes }
          : {}),
        ...(request.autoArchiveMinutes !== undefined
          ? { autoArchiveInterval: request.autoArchiveMinutes }
          : {}),
        ...(request.autoDeleteMinutes !== undefined
          ? { autoDeleteInterval: request.autoDeleteMinutes }
          : {}),
      };
      const sb = await this.daytona.create(
        params,
        request.timeoutSeconds !== undefined ? { timeout: request.timeoutSeconds } : undefined,
      );
      return toProviderSandbox(sb);
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async getSandbox(id: string): Promise<ProviderSandbox | null> {
    try {
      const sb = await this.daytona.get(id);
      return toProviderSandbox(sb);
    } catch (error) {
      if (error instanceof DaytonaNotFoundError) return null;
      throw mapDaytonaError(error);
    }
  }

  async listSandboxes(filter?: ListSandboxesFilter): Promise<ProviderSandbox[]> {
    try {
      const query = filter?.labels !== undefined ? { labels: filter.labels } : undefined;
      const result: ProviderSandbox[] = [];
      const wanted = filter?.states;
      for await (const sb of this.daytona.list(query)) {
        const mapped = toProviderSandbox(sb);
        if (wanted === undefined || wanted.includes(mapped.state)) {
          result.push(mapped);
        }
      }
      return result;
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async startSandbox(id: string, timeoutSeconds?: number): Promise<void> {
    try {
      const sb = await this.daytona.get(id);
      await sb.start(timeoutSeconds);
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async stopSandbox(id: string, timeoutSeconds?: number): Promise<void> {
    try {
      const sb = await this.daytona.get(id);
      await sb.stop(timeoutSeconds);
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async archiveSandbox(id: string): Promise<void> {
    try {
      const sb = await this.daytona.get(id);
      await sb.archive();
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async deleteSandbox(id: string): Promise<void> {
    try {
      const sb = await this.daytona.get(id);
      await sb.delete();
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async setLabels(id: string, labels: Record<string, string>): Promise<Record<string, string>> {
    try {
      const sb = await this.daytona.get(id);
      return await sb.setLabels(labels);
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async heartbeat(id: string): Promise<void> {
    try {
      const sb = await this.daytona.get(id);
      await sb.refreshActivity();
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async exec(id: string, request: ExecRequest): Promise<ExecResult> {
    try {
      const sb = await this.daytona.get(id);
      const response = await sb.process.executeCommand(
        request.command,
        request.cwd,
        request.env,
        request.timeoutSeconds,
      );
      return { exitCode: response.exitCode, output: response.result };
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async createPty(id: string, request: PtyRequest): Promise<ProviderPty> {
    try {
      const sb = await this.daytona.get(id);
      const handle = await sb.process.createPty({
        id: request.id,
        onData: request.onData,
        ...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
        ...(request.env !== undefined ? { envs: request.env } : {}),
        ...(request.cols !== undefined ? { cols: request.cols } : {}),
        ...(request.rows !== undefined ? { rows: request.rows } : {}),
      });
      return {
        sessionId: handle.sessionId,
        sendInput: (data) => handle.sendInput(data),
        resize: async (cols, rows) => {
          await handle.resize(cols, rows);
        },
        wait: async (): Promise<PtyExit> => {
          const result = await handle.wait();
          return {
            ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
            ...(result.error !== undefined ? { error: result.error } : {}),
          };
        },
        kill: () => handle.kill(),
        disconnect: () => handle.disconnect(),
      };
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }

  async getPreviewUrl(id: string, port: number): Promise<PreviewUrl> {
    try {
      const sb = await this.daytona.get(id);
      const preview = await sb.getPreviewLink(port);
      return {
        url: preview.url,
        ...(preview.token !== undefined && preview.token !== null ? { token: preview.token } : {}),
      };
    } catch (error) {
      throw mapDaytonaError(error);
    }
  }
}
