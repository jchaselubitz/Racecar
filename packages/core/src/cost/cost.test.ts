import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RESOURCE_CLASS_NAME,
  RESOURCE_CLASSES,
  buildResourceClasses,
  estimateSpendUsd,
  formatUsd,
  hourlyUsdForSpec,
  resolveResourceClass,
} from './index.js';

describe('resource classes', () => {
  it('prices a spec as the sum of its per-resource costs', () => {
    const pricing = { cpuHourUsd: 0.1, memoryGiBHourUsd: 0.01, diskGiBHourUsd: 0.001 };
    expect(hourlyUsdForSpec({ cpu: 2, memoryGiB: 4, diskGiB: 10 }, pricing)).toBeCloseTo(
      0.2 + 0.04 + 0.01,
      10,
    );
  });

  it('orders the built-in classes small < standard < large by hourly rate', () => {
    expect(RESOURCE_CLASSES.small.hourlyUsd).toBeLessThan(RESOURCE_CLASSES.standard.hourlyUsd);
    expect(RESOURCE_CLASSES.standard.hourlyUsd).toBeLessThan(RESOURCE_CLASSES.large.hourlyUsd);
  });

  it('resolves an undefined name to the default class', () => {
    expect(resolveResourceClass().name).toBe(DEFAULT_RESOURCE_CLASS_NAME);
  });

  it('resolves a known name to its class', () => {
    expect(resolveResourceClass('large').spec.cpu).toBe(4);
  });

  it('throws on an unknown class name', () => {
    expect(() => resolveResourceClass('gigantic')).toThrow(/unknown resource class 'gigantic'/);
  });

  it('lets a caller substitute their own pricing table', () => {
    const classes = buildResourceClasses({
      cpuHourUsd: 1,
      memoryGiBHourUsd: 0,
      diskGiBHourUsd: 0,
    });
    expect(classes.standard.hourlyUsd).toBe(RESOURCE_CLASSES.standard.spec.cpu);
  });
});

describe('estimateSpendUsd', () => {
  const now = new Date('2026-07-11T12:00:00.000Z');

  it('bills the elapsed hours since the timestamp at the hourly rate', () => {
    const twoHoursAgo = new Date(now.getTime() - 2 * 3_600_000).toISOString();
    expect(estimateSpendUsd(0.5, twoHoursAgo, now)).toBeCloseTo(1, 10);
  });

  it('returns 0 for a missing timestamp', () => {
    expect(estimateSpendUsd(0.5, undefined, now)).toBe(0);
  });

  it('returns 0 for an unparseable timestamp', () => {
    expect(estimateSpendUsd(0.5, 'not-a-date', now)).toBe(0);
  });

  it('never returns a negative estimate when the clock runs backwards', () => {
    const future = new Date(now.getTime() + 3_600_000).toISOString();
    expect(estimateSpendUsd(0.5, future, now)).toBe(0);
  });
});

describe('formatUsd', () => {
  it('renders two decimal places with a leading $', () => {
    expect(formatUsd(0.4)).toBe('$0.40');
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});
