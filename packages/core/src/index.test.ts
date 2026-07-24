import { describe, expect, it } from 'vitest';
import {
  CORE_PACKAGE,
  ProviderConflictError,
  encodeSandboxLabels,
  sandboxLabelSelector,
  toSandboxes,
} from './index.js';
import { FakeSandboxProvider } from './testing/index.js';

describe('@racecar/core scaffold', () => {
  it('exposes the package identifier', () => {
    expect(CORE_PACKAGE).toBe('@racecar/core');
  });

  it('round-trips self-describing labels and filters managed sandboxes', async () => {
    const provider = new FakeSandboxProvider({
      now: () => new Date('2026-07-10T12:00:00.000Z'),
      idPrefix: 'validation',
    });
    await provider.buildSnapshot({ name: 'racecar-snapshot', baseImage: 'node:24' });
    const labels = encodeSandboxLabels({
      project: 'racecar',
      mission: 'coo-246',
      branch: 'validation',
      snapshot: 'racecar-snapshot',
      createdAt: '2026-07-10T12:00:00.000Z',
      role: 'mission',
    });
    const created = await provider.createSandbox({ snapshot: 'racecar-snapshot', labels });

    expect(
      await provider.listSandboxes({ labels: sandboxLabelSelector({ project: 'racecar' }) }),
    ).toHaveLength(1);
    expect(toSandboxes([created])).toEqual([
      expect.objectContaining({
        id: 'validation-1',
        project: 'racecar',
        mission: 'coo-246',
        branch: 'validation',
        snapshot: 'racecar-snapshot',
        state: 'started',
      }),
    ]);
  });

  it('enforces stop-before-archive and supports a complete fake lifecycle', async () => {
    const provider = new FakeSandboxProvider();
    await provider.buildSnapshot({ name: 'racecar-snapshot', baseImage: 'node:24' });
    const sandbox = await provider.createSandbox({ snapshot: 'racecar-snapshot' });

    await expect(provider.archiveSandbox(sandbox.id)).rejects.toBeInstanceOf(ProviderConflictError);
    await provider.stopSandbox(sandbox.id);
    await provider.archiveSandbox(sandbox.id);
    expect((await provider.getSandbox(sandbox.id))?.state).toBe('archived');
    await provider.deleteSandbox(sandbox.id);
    expect(await provider.getSandbox(sandbox.id)).toBeNull();
  });
});
