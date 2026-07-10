import { describe, expect, it } from 'vitest';
import { parseShimRunning, readShimBundle } from './shim.js';

describe('parseShimRunning', () => {
  it('detects a running session and ignores the log tail', () => {
    expect(parseShimRunning('RUNNING\n{"msg":"shim listening"}')).toBe(true);
    expect(parseShimRunning('STOPPED\n')).toBe(false);
    expect(parseShimRunning('')).toBe(false);
  });
});

describe('readShimBundle', () => {
  it('reads the built, self-contained daemon bundle', async () => {
    const bundle = await readShimBundle();
    // It is the real bundle: a runnable node script that pulls in ws.
    expect(bundle.startsWith('#!/usr/bin/env node')).toBe(true);
    expect(bundle.length).toBeGreaterThan(1000);
  });
});
