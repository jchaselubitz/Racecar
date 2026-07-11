import { describe, expect, it } from 'vitest';
import { decideSnapshotRebuild, isSnapshotStale, type Snapshot } from './index.js';

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    name: 'racecar-snapshot',
    project: 'racecar',
    baseImage: 'node:22-bookworm-slim',
    lockfileHash: 'aaa',
    state: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('isSnapshotStale', () => {
  it('is stale when the baked lockfile hash differs from the checkout', () => {
    expect(isSnapshotStale(snapshot(), 'bbb')).toBe(true);
  });

  it('is fresh when the hashes match', () => {
    expect(isSnapshotStale(snapshot(), 'aaa')).toBe(false);
  });

  it('is never stale when the snapshot has no baked hash', () => {
    const { lockfileHash: _omit, ...noHash } = snapshot();
    expect(isSnapshotStale(noHash, 'bbb')).toBe(false);
  });
});

describe('decideSnapshotRebuild', () => {
  it('is fresh when the hashes match', () => {
    expect(decideSnapshotRebuild(snapshot(), 'aaa')).toBe('fresh');
  });

  it('is fresh when the checkout has no lockfile hash', () => {
    expect(decideSnapshotRebuild(snapshot(), undefined, { autoRebuild: true })).toBe('fresh');
  });

  it('warns on staleness when auto-rebuild is off', () => {
    expect(decideSnapshotRebuild(snapshot(), 'bbb')).toBe('warn');
  });

  it('rebuilds on staleness when auto-rebuild is on', () => {
    expect(decideSnapshotRebuild(snapshot(), 'bbb', { autoRebuild: true })).toBe('rebuild');
  });

  it('does not start a second rebuild while one is already building', () => {
    expect(decideSnapshotRebuild(snapshot({ state: 'building' }), 'bbb', { autoRebuild: true })).toBe(
      'building',
    );
  });
});
