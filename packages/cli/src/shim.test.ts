import { describe, expect, it } from 'vitest';
import type { ExecRequest } from '@racecar/core';
import { FakeSandboxProvider } from '@racecar/core/testing';
import { parseShimRunning, readShimBundle, rotateShimToken } from './shim.js';

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

describe('rotateShimToken', () => {
  it('reboots the daemon with the new token supplied out-of-band via exec env', async () => {
    const calls: ExecRequest[] = [];
    const provider = new FakeSandboxProvider({
      execHandler: (_id, request) => {
        calls.push(request);
        // The status probe reports the session is back up.
        return request.command.includes('has-session')
          ? { exitCode: 0, output: 'RUNNING\n' }
          : { exitCode: 0, output: '' };
      },
    });

    await provider.buildSnapshot({ name: 'snap', baseImage: 'node:22' });
    const { id } = await provider.createSandbox({ snapshot: 'snap' });
    const running = await rotateShimToken(provider, id, 'the-new-token');
    expect(running).toBe(true);

    const reboot = calls[0];
    // The new token rides in the exec env, never in the command string.
    expect(reboot?.env).toEqual({ RACECAR_SHIM_TOKEN: 'the-new-token' });
    expect(reboot?.command).not.toContain('the-new-token');
    expect(reboot?.command).toContain('shim.token');
  });

  it('reports the daemon did not come back when the status probe is not RUNNING', async () => {
    const provider = new FakeSandboxProvider({
      execHandler: () => ({ exitCode: 0, output: 'STOPPED\n' }),
    });
    await provider.buildSnapshot({ name: 'snap', baseImage: 'node:22' });
    const { id } = await provider.createSandbox({ snapshot: 'snap' });
    expect(await rotateShimToken(provider, id, 'tok')).toBe(false);
  });
});
