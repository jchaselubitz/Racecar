import { describe, expect, it } from 'vitest';
import {
  generateShimToken,
  SHIM_BUNDLE_PATH,
  SHIM_TMUX_SESSION,
  shimBootScript,
  shimStatusScript,
} from './index.js';

describe('generateShimToken', () => {
  it('produces distinct, URL-safe tokens', () => {
    const a = generateShimToken();
    const b = generateShimToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(a.length).toBeGreaterThanOrEqual(40);
  });
});

describe('shimBootScript', () => {
  const script = shimBootScript({ bundle: "console.log('shim')" });

  it('writes the bundle, then relaunches the shim detached in tmux', () => {
    // Bundle is shipped base64-decoded into a file — no source literal on the line.
    expect(script).toContain('base64 -d >');
    expect(script).toContain(SHIM_BUNDLE_PATH);
    expect(script).not.toContain("console.log('shim')");
    // Idempotent restart: kill any prior session, then start detached.
    expect(script).toContain(`tmux kill-session -t '${SHIM_TMUX_SESSION}'`);
    expect(script).toContain(`tmux new-session -d -s '${SHIM_TMUX_SESSION}'`);
  });

  it('never interpolates the token (read from the daemon env, not the script)', () => {
    expect(script).not.toContain('RACECAR_SHIM_TOKEN=');
  });

  it('honors a custom bundle path and session', () => {
    const custom = shimBootScript({
      bundle: 'x',
      bundlePath: '/srv/shim.cjs',
      session: 'custom-shim',
    });
    expect(custom).toContain('/srv/shim.cjs');
    expect(custom).toContain(`tmux new-session -d -s 'custom-shim'`);
  });
});

describe('shimStatusScript', () => {
  it('probes the session and tails the log', () => {
    const script = shimStatusScript();
    expect(script).toContain(`tmux has-session -t '${SHIM_TMUX_SESSION}'`);
    expect(script).toContain('RUNNING');
    expect(script).toContain('shim.log');
  });
});
