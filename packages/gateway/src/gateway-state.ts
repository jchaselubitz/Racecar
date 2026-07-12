import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Persisted gateway lifecycle states. Terminal records are intentionally retained. */
export type GatewayRequestState = 'reserved' | 'attached' | 'running' | 'completed' | 'failed';

/**
 * Racecar-owned identity for an Overlord execution request. Overlord records
 * only the working directory; this makes the sandbox and ACP assignment
 * durable across a gateway restart.
 */
export interface GatewayExecutionRecord {
  readonly executionRequestId: string;
  readonly missionId: string;
  readonly projectName: string;
  readonly resourceKey: string;
  readonly branch: string;
  readonly workingDirectory: string;
  readonly sandboxId: string;
  readonly state: GatewayRequestState;
  readonly acpSessionId?: string;
  readonly protocolSessionKey?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly failure?: string;
}

export interface GatewayReservation {
  readonly record: GatewayExecutionRecord;
  /** True when the execution request was already recorded before this claim. */
  readonly reused: boolean;
}

export interface ReserveGatewayRequestInput {
  readonly executionRequestId: string;
  readonly missionId: string;
  readonly projectName: string;
  readonly resourceKey: string;
  readonly branch: string;
  readonly workingDirectory: string;
  readonly sandboxId: string;
}

interface GatewayStateFile {
  readonly version: 1;
  readonly requests: GatewayExecutionRecord[];
}

const ACTIVE_STATES = new Set<GatewayRequestState>(['reserved', 'attached', 'running']);

/**
 * Small atomic file store for the gateway's non-Overlord state. The directory
 * must be mounted on durable storage; storing this beside the normal Racecar
 * project state keeps sandbox recovery and request recovery co-located.
 */
export class GatewayStateStore {
  readonly #file: string;
  #tail: Promise<void> = Promise.resolve();

  constructor(stateDirectory: string) {
    this.#file = join(stateDirectory, '.racecar', 'gateway-state', 'execution-requests.json');
  }

  async reserve(input: ReserveGatewayRequestInput): Promise<GatewayReservation> {
    return this.#mutate<GatewayReservation>((file) => {
      const existing = file.requests.find(
        (record) => record.executionRequestId === input.executionRequestId,
      );
      if (existing !== undefined) {
        assertSameRequest(existing, input);
        return { value: { record: existing, reused: true }, file };
      }

      const conflict = file.requests.find(
        (record) =>
          ACTIVE_STATES.has(record.state) &&
          record.projectName === input.projectName &&
          record.resourceKey === input.resourceKey &&
          record.branch === input.branch &&
          record.missionId === input.missionId,
      );
      if (conflict !== undefined) {
        throw new Error(
          `gateway assignment ${input.projectName}/${input.resourceKey}@${input.branch} is already active for execution request '${conflict.executionRequestId}'`,
        );
      }

      const now = new Date().toISOString();
      const record: GatewayExecutionRecord = {
        ...input,
        state: 'reserved',
        createdAt: now,
        updatedAt: now,
      };
      return {
        value: { record, reused: false },
        file: { ...file, requests: [...file.requests, record] },
      };
    });
  }

  /** Persist the ACP session before its first prompt is sent. */
  async bindAcpSession(
    executionRequestId: string,
    acpSessionId: string,
  ): Promise<GatewayExecutionRecord> {
    return this.#update(executionRequestId, (record) => {
      if (record.acpSessionId !== undefined && record.acpSessionId !== acpSessionId) {
        throw new Error(
          `execution request '${executionRequestId}' is already bound to another ACP session`,
        );
      }
      return { ...record, acpSessionId, state: 'attached' };
    });
  }

  /** Persist the protocol key before the already-created ACP session is prompted. */
  async bindProtocolSession(
    executionRequestId: string,
    protocolSessionKey: string,
  ): Promise<GatewayExecutionRecord> {
    return this.#update(executionRequestId, (record) => {
      if (
        record.protocolSessionKey !== undefined &&
        record.protocolSessionKey !== protocolSessionKey
      ) {
        throw new Error(
          `execution request '${executionRequestId}' is already bound to another protocol session`,
        );
      }
      return { ...record, protocolSessionKey, state: 'attached' };
    });
  }

  /** This write is the recovery fence immediately before the first ACP prompt. */
  async markPrompted(executionRequestId: string): Promise<GatewayExecutionRecord> {
    return this.#update(executionRequestId, (record) => ({ ...record, state: 'running' }));
  }

  async markCompleted(executionRequestId: string): Promise<GatewayExecutionRecord> {
    return this.#update(executionRequestId, (record) => ({ ...record, state: 'completed' }));
  }

  async markFailed(executionRequestId: string, failure: string): Promise<GatewayExecutionRecord> {
    return this.#update(executionRequestId, (record) => ({ ...record, state: 'failed', failure }));
  }

  async #update(
    executionRequestId: string,
    transform: (record: GatewayExecutionRecord) => Omit<GatewayExecutionRecord, 'updatedAt'>,
  ): Promise<GatewayExecutionRecord> {
    return this.#mutate((file) => {
      const index = file.requests.findIndex(
        (record) => record.executionRequestId === executionRequestId,
      );
      if (index < 0)
        throw new Error(`gateway state has no execution request '${executionRequestId}'`);
      const current = file.requests[index]!;
      const record: GatewayExecutionRecord = {
        ...transform(current),
        updatedAt: new Date().toISOString(),
      };
      const requests = [...file.requests];
      requests[index] = record;
      return { value: record, file: { ...file, requests } };
    });
  }

  async #mutate<T>(
    operation: (file: GatewayStateFile) => { readonly value: T; readonly file: GatewayStateFile },
  ): Promise<T> {
    let resolve: (() => void) | undefined;
    const previous = this.#tail;
    this.#tail = new Promise<void>((next) => {
      resolve = next;
    });
    await previous;
    try {
      const result = operation(await this.#read());
      await this.#write(result.file);
      return result.value;
    } finally {
      resolve?.();
    }
  }

  async #read(): Promise<GatewayStateFile> {
    try {
      const file = JSON.parse(await readFile(this.#file, 'utf8')) as GatewayStateFile;
      if (file.version !== 1 || !Array.isArray(file.requests)) {
        throw new Error(`gateway state file '${this.#file}' has an unsupported format`);
      }
      return file;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, requests: [] };
      throw error;
    }
  }

  async #write(file: GatewayStateFile): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporary, this.#file);
  }
}

function assertSameRequest(
  record: GatewayExecutionRecord,
  input: ReserveGatewayRequestInput,
): void {
  for (const key of [
    'missionId',
    'projectName',
    'resourceKey',
    'branch',
    'workingDirectory',
    'sandboxId',
  ] as const) {
    if (record[key] !== input[key]) {
      throw new Error(
        `execution request '${input.executionRequestId}' was retried with a different ${key}; refusing to duplicate its sandbox/session assignment`,
      );
    }
  }
}
