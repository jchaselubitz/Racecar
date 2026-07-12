import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { GatewayStateStore } from './gateway-state.js';

const directories: string[] = [];

async function store(): Promise<GatewayStateStore> {
  const directory = await mkdtemp(join(tmpdir(), 'racecar-gateway-state-'));
  directories.push(directory);
  return new GatewayStateStore(directory);
}

const request = {
  executionRequestId: 'request-1',
  missionId: 'mission-1',
  projectName: 'app',
  resourceKey: 'primary',
  branch: 'main',
  workingDirectory: '/home/daytona/workspace',
  sandboxId: 'sandbox-1',
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('GatewayStateStore', () => {
  it('reuses a persisted request/session assignment after a restart', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'racecar-gateway-state-'));
    directories.push(directory);
    const first = new GatewayStateStore(directory);
    await first.reserve(request);
    await first.bindAcpSession(request.executionRequestId, 'acp-1');
    await first.bindProtocolSession(request.executionRequestId, 'protocol-1');
    await first.markPrompted(request.executionRequestId);

    const second = new GatewayStateStore(directory);
    await expect(second.reserve(request)).resolves.toMatchObject({
      reused: true,
      record: { state: 'running', acpSessionId: 'acp-1', protocolSessionKey: 'protocol-1' },
    });
  });

  it('does not assign a second active request to the same mission resource and branch', async () => {
    const state = await store();
    await state.reserve(request);
    await expect(state.reserve({ ...request, executionRequestId: 'request-2' })).rejects.toThrow(
      /already active/,
    );
  });

  it('allows a new assignment after the prior request reaches a terminal state', async () => {
    const state = await store();
    await state.reserve(request);
    await state.markCompleted(request.executionRequestId);
    await expect(
      state.reserve({ ...request, executionRequestId: 'request-2', sandboxId: 'sandbox-2' }),
    ).resolves.toMatchObject({
      reused: false,
      record: { state: 'reserved', sandboxId: 'sandbox-2' },
    });
  });

  it('reserves distinct concurrent requests for different projects exactly once each', async () => {
    const state = await store();
    const inputs = Array.from({ length: 25 }, (_, index) => ({
      ...request,
      executionRequestId: `request-${index}`,
      missionId: `mission-${index}`,
      projectName: `project-${index}`,
      sandboxId: `sandbox-${index}`,
    }));

    const results = await Promise.all(inputs.map((input) => state.reserve(input)));

    expect(results.every((result) => !result.reused)).toBe(true);
    const sandboxes = new Set(results.map((result) => result.record.sandboxId));
    expect(sandboxes.size).toBe(inputs.length);
  });

  it('collapses concurrent retries of one request to a single reservation', async () => {
    const state = await store();

    const results = await Promise.all(
      Array.from({ length: 12 }, () => state.reserve(request)),
    );

    const fresh = results.filter((result) => !result.reused);
    expect(fresh).toHaveLength(1);
    expect(results.every((result) => result.record.sandboxId === request.sandboxId)).toBe(true);
  });

  it('rejects all but one of many concurrent requests contending for one assignment', async () => {
    const state = await store();
    const contenders = Array.from({ length: 12 }, (_, index) =>
      state.reserve({ ...request, executionRequestId: `request-${index}`, sandboxId: `sandbox-${index}` }),
    );

    const settled = await Promise.allSettled(contenders);
    const won = settled.filter((result) => result.status === 'fulfilled');
    const lost = settled.filter((result) => result.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(contenders.length - 1);
    expect(
      lost.every(
        (result) =>
          result.status === 'rejected' && /already active/.test(String(result.reason)),
      ),
    ).toBe(true);
  });
});
