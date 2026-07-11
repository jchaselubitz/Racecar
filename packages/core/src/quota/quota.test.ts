import { describe, expect, it } from 'vitest';
import { QuotaExceededError, evaluateQuota } from './index.js';

const ADD_ONE = { concurrentSandboxes: 1, hourlySpendUsd: 0.12 };

describe('evaluateQuota', () => {
  it('admits a candidate that fits both caps', () => {
    const violations = evaluateQuota(
      'project',
      { concurrentSandboxes: 2, hourlySpendUsd: 0.24 },
      ADD_ONE,
      { maxConcurrentSandboxes: 5, maxHourlySpendUsd: 1 },
    );
    expect(violations).toEqual([]);
  });

  it('flags the concurrency cap when the candidate would exceed it', () => {
    const violations = evaluateQuota(
      'project',
      { concurrentSandboxes: 5, hourlySpendUsd: 0 },
      ADD_ONE,
      { maxConcurrentSandboxes: 5 },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.limit).toBe('maxConcurrentSandboxes');
    expect(violations[0]?.projected).toBe(6);
  });

  it('flags the hourly-spend cap when the candidate would exceed it', () => {
    const violations = evaluateQuota(
      'org',
      { concurrentSandboxes: 1, hourlySpendUsd: 0.95 },
      ADD_ONE,
      { maxHourlySpendUsd: 1 },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.scope).toBe('org');
    expect(violations[0]?.limit).toBe('maxHourlySpendUsd');
  });

  it('reports both caps at once', () => {
    const violations = evaluateQuota(
      'project',
      { concurrentSandboxes: 5, hourlySpendUsd: 1 },
      ADD_ONE,
      { maxConcurrentSandboxes: 5, maxHourlySpendUsd: 1 },
    );
    expect(violations.map((v) => v.limit)).toEqual([
      'maxConcurrentSandboxes',
      'maxHourlySpendUsd',
    ]);
  });

  it('treats an undefined or non-positive cap as unlimited', () => {
    expect(
      evaluateQuota('project', { concurrentSandboxes: 100, hourlySpendUsd: 100 }, ADD_ONE, {}),
    ).toEqual([]);
    expect(
      evaluateQuota('project', { concurrentSandboxes: 100, hourlySpendUsd: 100 }, ADD_ONE, {
        maxConcurrentSandboxes: 0,
        maxHourlySpendUsd: 0,
      }),
    ).toEqual([]);
  });

  it('admits a candidate that lands exactly on the spend cap despite float noise', () => {
    const violations = evaluateQuota(
      'project',
      { concurrentSandboxes: 0, hourlySpendUsd: 0.1 + 0.2 },
      { concurrentSandboxes: 1, hourlySpendUsd: 0.3 },
      { maxHourlySpendUsd: 0.6 },
    );
    expect(violations).toEqual([]);
  });
});

describe('QuotaExceededError', () => {
  it('summarizes every violation message and carries them', () => {
    const violations = evaluateQuota(
      'project',
      { concurrentSandboxes: 5, hourlySpendUsd: 0 },
      ADD_ONE,
      { maxConcurrentSandboxes: 5 },
    );
    const error = new QuotaExceededError(violations);
    expect(error.name).toBe('QuotaExceededError');
    expect(error.violations).toHaveLength(1);
    expect(error.message).toContain('concurrent sandbox cap');
  });
});
