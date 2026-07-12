import { encodeSandboxLabels } from '@racecar/core';
import { FakeSandboxProvider } from '@racecar/core/testing';
import { describe, expect, it } from 'vitest';
import { ShimLaunchAdapter, type RunnerClaim } from './launch-adapter.js';
import { SandboxWaker, type RunnerQueueStatus } from './sandbox-waker.js';

const SNAPSHOT = 'snap';

async function seed(
  provider: FakeSandboxProvider,
  spec: { id: string; mission: string; branch: string; state: 'started' | 'stopped' | 'archived' },
): Promise<void> {
  await provider.createSandbox({
    snapshot: SNAPSHOT,
    name: spec.id,
    labels: encodeSandboxLabels({
      project: 'demo',
      mission: spec.mission,
      branch: spec.branch,
      snapshot: SNAPSHOT,
      createdAt: '2026-07-12T00:00:00.000Z',
    }),
  });
  if (spec.state === 'stopped' || spec.state === 'archived') await provider.stopSandbox(spec.id);
  if (spec.state === 'archived') await provider.archiveSandbox(spec.id);
}

async function stateOf(provider: FakeSandboxProvider, id: string): Promise<string> {
  return (await provider.getSandbox(id))!.state;
}

async function newProvider(): Promise<FakeSandboxProvider> {
  const provider = new FakeSandboxProvider();
  await provider.buildSnapshot({ name: SNAPSHOT, baseImage: 'base' });
  return provider;
}

function status(queue: RunnerClaim[]): () => Promise<RunnerQueueStatus> {
  return () => Promise.resolve({ queue, activeCount: 0 });
}

describe('ShimLaunchAdapter.wake', () => {
  it('resumes only stopped/archived sandboxes matching the mission and branch', async () => {
    const provider = await newProvider();
    await seed(provider, { id: 'a', mission: 'm1', branch: 'main', state: 'stopped' });
    await seed(provider, { id: 'b', mission: 'm1', branch: 'main', state: 'archived' });
    await seed(provider, { id: 'c', mission: 'm1', branch: 'main', state: 'started' });
    await seed(provider, { id: 'd', mission: 'm1', branch: 'feature', state: 'stopped' });
    await seed(provider, { id: 'e', mission: 'm2', branch: 'main', state: 'stopped' });
    const adapter = new ShimLaunchAdapter({ provider });

    const started = await adapter.wake({ id: 'r1', missionId: 'm1', branch: 'main' });

    expect([...started].sort()).toEqual(['a', 'b']);
    expect(await stateOf(provider, 'a')).toBe('started');
    expect(await stateOf(provider, 'b')).toBe('started');
    expect(await stateOf(provider, 'd')).toBe('stopped'); // other branch
    expect(await stateOf(provider, 'e')).toBe('stopped'); // other mission
  });

  it('resumes every branch of the mission when the claim names no branch', async () => {
    const provider = await newProvider();
    await seed(provider, { id: 'a', mission: 'm1', branch: 'main', state: 'stopped' });
    await seed(provider, { id: 'd', mission: 'm1', branch: 'feature', state: 'archived' });
    const adapter = new ShimLaunchAdapter({ provider });

    const started = await adapter.wake({ id: 'r1', missionId: 'm1' });

    expect([...started].sort()).toEqual(['a', 'd']);
  });

  it('does nothing when the mission has no sandbox yet', async () => {
    const provider = await newProvider();
    const adapter = new ShimLaunchAdapter({ provider });
    expect(await adapter.wake({ id: 'r1', missionId: 'never-provisioned' })).toEqual([]);
  });
});

describe('SandboxWaker.tick', () => {
  it('wakes each queued mission once and survives per-mission failures', async () => {
    const provider = await newProvider();
    await seed(provider, { id: 'a', mission: 'm1', branch: 'main', state: 'stopped' });
    await seed(provider, { id: 'b', mission: 'm2', branch: 'main', state: 'archived' });
    const adapter = new ShimLaunchAdapter({ provider });
    const messages: string[] = [];
    const waker = new SandboxWaker({
      adapter,
      fetchStatus: status([
        { id: 'r1', missionId: 'm1', branch: 'main' },
        // Duplicate mission/branch collapses to a single wake.
        { id: 'r2', missionId: 'm1', branch: 'main' },
        { id: 'r3', missionId: 'm2', branch: 'main' },
        // Malformed queue rows are skipped, not fatal.
        { id: 'r4', missionId: '' },
      ]),
      log: (message) => messages.push(message),
    });

    await waker.tick();

    expect(await stateOf(provider, 'a')).toBe('started');
    expect(await stateOf(provider, 'b')).toBe('started');
    expect(messages.filter((message) => message.includes('resumed'))).toHaveLength(2);
  });

  it('logs and continues when a single wake throws', async () => {
    const adapter = {
      wake: (request: RunnerClaim) => {
        if (request.missionId === 'boom') return Promise.reject(new Error('provider down'));
        return Promise.resolve(['sbx-ok']);
      },
    } as unknown as ShimLaunchAdapter;
    const messages: string[] = [];
    const waker = new SandboxWaker({
      adapter,
      fetchStatus: status([
        { id: 'r1', missionId: 'boom' },
        { id: 'r2', missionId: 'fine' },
      ]),
      log: (message) => messages.push(message),
    });

    await waker.tick();

    expect(messages.some((message) => message.includes('wake failed for mission boom'))).toBe(true);
    expect(messages.some((message) => message.includes('resumed 1 sandbox(es) for mission fine'))).toBe(
      true,
    );
  });
});
