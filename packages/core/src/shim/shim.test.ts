import { describe, expect, it } from 'vitest';
import {
  generateShimToken,
  SHIM_BUNDLE_PATH,
  SHIM_TMUX_SESSION,
  SHIM_TOKEN_ENV,
  shimBootScript,
  shimRebootScript,
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

  it('never interpolates the token value (only references the env var name)', () => {
    // The token file is written from the env var, so the var name appears — but
    // no `NAME=value` assignment that would embed a literal secret.
    expect(script).not.toContain(`${SHIM_TOKEN_ENV}=`);
    expect(script).toContain(`"$${SHIM_TOKEN_ENV}"`);
  });

  it('materializes the token file 0600 from the env var', () => {
    expect(script).toContain('shim.token');
    expect(script).toContain(`printf '%s' "$${SHIM_TOKEN_ENV}" >`);
    expect(script).toContain('chmod 600');
    expect(script).toContain('umask 077');
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

describe('shimRebootScript', () => {
  const script = shimRebootScript();

  it('rewrites the token file and restarts the daemon without re-delivering the bundle', () => {
    // Rotation-only: no bundle re-shipping (that stays in shimBootScript).
    expect(script).not.toContain('base64 -d >');
    expect(script).toContain(`printf '%s' "$${SHIM_TOKEN_ENV}" >`);
    expect(script).toContain('shim.token');
    expect(script).toContain(`tmux kill-session -t '${SHIM_TMUX_SESSION}'`);
    expect(script).toContain(`tmux new-session -d -s '${SHIM_TMUX_SESSION}'`);
  });

  it('never embeds a token literal', () => {
    expect(script).not.toContain(`${SHIM_TOKEN_ENV}=`);
  });

  it('runs the on-disk bundle by default', () => {
    expect(script).toContain(SHIM_BUNDLE_PATH);
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
