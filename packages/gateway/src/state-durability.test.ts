import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeDurability, ensureDurableStateDir } from './state-durability.js';

const directories: string[] = [];

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'racecar-durability-'));
  directories.push(directory);
  return directory;
}

const clockAt = (iso: string) => () => new Date(iso);

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('ensureDurableStateDir', () => {
  it('writes a fresh marker on the first boot', async () => {
    const stateDirectory = await tempDir();
    const result = await ensureDurableStateDir({
      stateDirectory,
      deviceFingerprint: 'fingerprint-1',
      instanceId: 'instance-1',
      now: clockAt('2026-07-24T00:00:00.000Z'),
      imageDirectory: '/app',
    });

    expect(result.resumed).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.marker).toMatchObject({ bootCount: 1, deviceFingerprint: 'fingerprint-1' });
    expect(describeDurability(result)).toMatch(/first boot/);
  });

  it('resumes and increments the boot count when the marker survives', async () => {
    const stateDirectory = await tempDir();
    const options = {
      stateDirectory,
      deviceFingerprint: 'fingerprint-1',
      instanceId: 'instance-1',
      imageDirectory: '/app',
    };
    await ensureDurableStateDir({ ...options, now: clockAt('2026-07-24T00:00:00.000Z') });
    const second = await ensureDurableStateDir({
      ...options,
      instanceId: 'instance-2',
      now: clockAt('2026-07-24T01:00:00.000Z'),
    });

    expect(second.resumed).toBe(true);
    expect(second.warnings).toEqual([]);
    expect(second.marker).toMatchObject({
      bootCount: 2,
      firstSeenAt: '2026-07-24T00:00:00.000Z',
      lastSeenAt: '2026-07-24T01:00:00.000Z',
      lastInstanceId: 'instance-2',
    });
    expect(describeDurability(second)).toMatch(/resumed persistent state/);
  });

  it('warns but keeps the original fingerprint when it changes across boots', async () => {
    const stateDirectory = await tempDir();
    await ensureDurableStateDir({
      stateDirectory,
      deviceFingerprint: 'fingerprint-1',
      instanceId: 'instance-1',
      now: clockAt('2026-07-24T00:00:00.000Z'),
      imageDirectory: '/app',
    });
    const second = await ensureDurableStateDir({
      stateDirectory,
      deviceFingerprint: 'fingerprint-CHANGED',
      instanceId: 'instance-2',
      now: clockAt('2026-07-24T01:00:00.000Z'),
      imageDirectory: '/app',
    });

    expect(second.warnings).toHaveLength(1);
    expect(second.warnings[0]).toMatch(/device fingerprint must stay stable/);
    expect(second.marker.deviceFingerprint).toBe('fingerprint-1');
  });

  it('rejects a state directory nested inside the image tree', async () => {
    const imageDirectory = await tempDir();
    await expect(
      ensureDurableStateDir({
        stateDirectory: join(imageDirectory, 'state'),
        deviceFingerprint: 'fingerprint-1',
        instanceId: 'instance-1',
        now: clockAt('2026-07-24T00:00:00.000Z'),
        imageDirectory,
      }),
    ).rejects.toThrow(/replaced on every redeploy/);
  });

  it('rejects the image directory itself', async () => {
    const imageDirectory = await tempDir();
    await expect(
      ensureDurableStateDir({
        stateDirectory: imageDirectory,
        deviceFingerprint: 'fingerprint-1',
        instanceId: 'instance-1',
        now: clockAt('2026-07-24T00:00:00.000Z'),
        imageDirectory,
      }),
    ).rejects.toThrow(/replaced on every redeploy/);
  });

  it('allows a sibling directory next to the image tree', async () => {
    const parent = await tempDir();
    const result = await ensureDurableStateDir({
      stateDirectory: join(parent, 'data'),
      deviceFingerprint: 'fingerprint-1',
      instanceId: 'instance-1',
      now: clockAt('2026-07-24T00:00:00.000Z'),
      imageDirectory: join(parent, 'app'),
    });
    expect(result.resumed).toBe(false);
  });

  it('persists the marker beside the gateway state file', async () => {
    const stateDirectory = await tempDir();
    await ensureDurableStateDir({
      stateDirectory,
      deviceFingerprint: 'fingerprint-1',
      instanceId: 'instance-1',
      now: clockAt('2026-07-24T00:00:00.000Z'),
      imageDirectory: '/app',
    });
    const raw = await readFile(
      join(stateDirectory, '.racecar', 'gateway-state', 'persistence.json'),
      'utf8',
    );
    expect(JSON.parse(raw)).toMatchObject({ version: 1, deviceFingerprint: 'fingerprint-1' });
  });
});
