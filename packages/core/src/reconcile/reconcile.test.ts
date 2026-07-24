import { describe, expect, it } from 'vitest';
import type { Sandbox } from '../domain/sandbox.js';
import type { SandboxRuntimeState } from '../provider/provider.js';
import { Redactor } from '../credentials/redaction.js';
import { FakeSandboxProvider } from '../testing/index.js';
import {
  buildLogArtifact,
  captureLogsScript,
  DEFAULT_RECONCILE_POLICY,
  executeReconciliation,
  planReconciliation,
  type LogArtifact,
  type ReconcileObservation,
} from './index.js';

const NOW = new Date('2026-07-11T12:00:00.000Z');

function sandbox(
  id: string,
  state: SandboxRuntimeState,
  overrides: Partial<Sandbox> = {},
): Sandbox {
  return {
    id,
    state,
    project: 'racecar',
    mission: 'coo-250',
    branch: 'main',
    snapshot: 'racecar-snapshot',
    createdAt: '2026-07-01T00:00:00.000Z',
    labels: {},
    ...overrides,
  };
}

function minutesAgo(min: number): string {
  return new Date(NOW.getTime() - min * 60_000).toISOString();
}

describe('planReconciliation', () => {
  it('flags an error-state sandbox for orphan deletion, capturing logs', () => {
    const actions = planReconciliation([{ sandbox: sandbox('a', 'error') }], undefined, () => NOW);
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'orphan-delete', sandboxId: 'a', captureLogs: true }),
    ]);
  });

  it('deletes an archived sandbox only once it is past the retention window', () => {
    const fresh: ReconcileObservation = {
      sandbox: sandbox('fresh', 'archived', { lastActivityAt: minutesAgo(60) }),
    };
    const old: ReconcileObservation = {
      sandbox: sandbox('old', 'archived', { lastActivityAt: minutesAgo(8 * 24 * 60) }),
    };
    const actions = planReconciliation(
      [fresh, old],
      { retentionDays: 7, maxRunMinutes: 180 },
      () => NOW,
    );
    expect(actions.map((a) => a.sandboxId)).toEqual(['old']);
    expect(actions[0]).toMatchObject({ kind: 'retention-delete', captureLogs: false });
  });

  it('halts a started sandbox whose run has overrun the budget', () => {
    const observations: ReconcileObservation[] = [
      { sandbox: sandbox('ok', 'started'), runningRunMinutes: 30, runningRunId: 'run-ok' },
      { sandbox: sandbox('stuck', 'started'), runningRunMinutes: 200, runningRunId: 'run-stuck' },
    ];
    const actions = planReconciliation(
      observations,
      { retentionDays: 7, maxRunMinutes: 180 },
      () => NOW,
    );
    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'halt-stuck-run',
        sandboxId: 'stuck',
        captureLogs: true,
      }),
    ]);
    expect(actions[0]?.reason).toContain('run-stuck');
  });

  it('leaves healthy sandboxes alone', () => {
    const observations: ReconcileObservation[] = [
      { sandbox: sandbox('running', 'started'), runningRunMinutes: 5 },
      { sandbox: sandbox('idle', 'stopped') },
      { sandbox: sandbox('recent-archive', 'archived', { lastActivityAt: minutesAgo(10) }) },
    ];
    expect(planReconciliation(observations, DEFAULT_RECONCILE_POLICY, () => NOW)).toEqual([]);
  });
});

describe('buildLogArtifact', () => {
  it('redacts secrets before bounding and keeps the tail', () => {
    const raw = `secret=SUPER_SECRET_TOKEN\n${'x'.repeat(100)}TAIL`;
    const artifact = buildLogArtifact('sbx', raw, {
      redactor: new Redactor(['SUPER_SECRET_TOKEN']),
      maxBytes: 20,
      now: () => NOW,
    });
    expect(artifact.content).not.toContain('SUPER_SECRET_TOKEN');
    expect(artifact.truncated).toBe(true);
    expect(artifact.content.endsWith('TAIL')).toBe(true);
    expect(artifact.bytes).toBeLessThanOrEqual(20);
    expect(artifact.capturedAt).toBe(NOW.toISOString());
  });

  it('passes short logs through untruncated', () => {
    const artifact = buildLogArtifact('sbx', 'short log', { maxBytes: 1024, now: () => NOW });
    expect(artifact).toMatchObject({ content: 'short log', truncated: false });
  });

  it('bounds a per-file tail in the capture script', () => {
    expect(captureLogsScript(4096)).toContain('tail -c 4096');
  });
});

describe('executeReconciliation', () => {
  it('captures a redacted artifact then deletes an orphaned sandbox', async () => {
    const provider = new FakeSandboxProvider({
      execHandler: () => ({ exitCode: 0, output: 'boom: SECRET_VALUE_XYZ leaked' }),
    });
    await provider.buildSnapshot({ name: 'snap', baseImage: 'node:24' });
    const created = await provider.createSandbox({ snapshot: 'snap', name: 'orphan' });

    const persisted: LogArtifact[] = [];
    const results = await executeReconciliation(
      [
        {
          kind: 'orphan-delete',
          sandboxId: created.id,
          reason: 'error state',
          captureLogs: true,
        },
      ],
      {
        provider,
        redactor: new Redactor(['SECRET_VALUE_XYZ']),
        persistArtifact: (artifact) => {
          persisted.push(artifact);
        },
        now: () => NOW,
      },
    );

    expect(results[0]?.outcome).toBe('done');
    expect(await provider.getSandbox(created.id)).toBeNull();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.content).toContain('«redacted»');
    expect(persisted[0]?.content).not.toContain('SECRET_VALUE_XYZ');
  });

  it('stops a sandbox with a stuck run and records the failure of a bad action', async () => {
    const provider = new FakeSandboxProvider();
    await provider.buildSnapshot({ name: 'snap', baseImage: 'node:24' });
    const live = await provider.createSandbox({ snapshot: 'snap', name: 'live' });

    const results = await executeReconciliation(
      [
        { kind: 'halt-stuck-run', sandboxId: live.id, reason: 'overrun', captureLogs: true },
        { kind: 'retention-delete', sandboxId: 'ghost', reason: 'gone', captureLogs: false },
      ],
      { provider },
    );

    expect((await provider.getSandbox(live.id))?.state).toBe('stopped');
    expect(results[0]?.outcome).toBe('done');
    expect(results[1]?.outcome).toBe('error');
    expect(results[1]?.error).toMatch(/not found/i);
  });

  it('wraps each provider op with the supplied withOp hook', async () => {
    const provider = new FakeSandboxProvider();
    await provider.buildSnapshot({ name: 'snap', baseImage: 'node:24' });
    const created = await provider.createSandbox({ snapshot: 'snap', name: 'wrapme' });
    await provider.stopSandbox(created.id);
    let wrapped = 0;
    const withOp = <T>(op: () => Promise<T>): Promise<T> => {
      wrapped += 1;
      return op();
    };
    await executeReconciliation(
      [{ kind: 'retention-delete', sandboxId: created.id, reason: 'old', captureLogs: false }],
      { provider, withOp },
    );
    expect(wrapped).toBeGreaterThan(0);
    expect(await provider.getSandbox(created.id)).toBeNull();
  });
});
