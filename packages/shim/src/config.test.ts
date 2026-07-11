import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SHIM_AGENT_ARGS_ENV,
  SHIM_AGENT_COMMAND_ENV,
  SHIM_AGENT_ENV,
  SHIM_DEFAULT_PORT,
  SHIM_PORT_ENV,
  SHIM_TOKEN_ENV,
  SHIM_TOKEN_FILE_RELATIVE,
} from './contract.js';
import { ConfigError, loadConfig } from './config.js';

/** A throwaway HOME containing a token file, for the file-preference tests. */
function homeWithTokenFile(token: string): string {
  const home = mkdtempSync(join(tmpdir(), 'racecar-shim-home-'));
  const path = join(home, SHIM_TOKEN_FILE_RELATIVE);
  mkdirSync(join(home, '.racecar'), { recursive: true });
  writeFileSync(path, `${token}\n`);
  return home;
}

describe('loadConfig', () => {
  it('requires a token', () => {
    // Point HOME at an empty dir so no stray host token file is picked up.
    const home = mkdtempSync(join(tmpdir(), 'racecar-shim-empty-'));
    expect(() => loadConfig({ HOME: home })).toThrow(ConfigError);
    expect(() => loadConfig({ HOME: home, [SHIM_TOKEN_ENV]: '' })).toThrow(ConfigError);
  });

  it('prefers the token file over the injected env var (rotation-aware)', () => {
    const home = homeWithTokenFile('rotated-token');
    const config = loadConfig({ HOME: home, [SHIM_TOKEN_ENV]: 'original-token' });
    expect(config.token).toBe('rotated-token');
  });

  it('falls back to the env var when no token file exists', () => {
    const home = mkdtempSync(join(tmpdir(), 'racecar-shim-empty-'));
    const config = loadConfig({ HOME: home, [SHIM_TOKEN_ENV]: 'env-token' });
    expect(config.token).toBe('env-token');
  });

  it('defaults the port, host, and echo agent', () => {
    const config = loadConfig({ [SHIM_TOKEN_ENV]: 'tok' });
    expect(config).toEqual({
      token: 'tok',
      port: SHIM_DEFAULT_PORT,
      host: '0.0.0.0',
      agent: { kind: 'echo', command: '', args: [] },
    });
  });

  it('honors an override port and rejects an invalid one', () => {
    expect(loadConfig({ [SHIM_TOKEN_ENV]: 'tok', [SHIM_PORT_ENV]: '4321' }).port).toBe(4321);
    expect(() => loadConfig({ [SHIM_TOKEN_ENV]: 'tok', [SHIM_PORT_ENV]: 'abc' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ [SHIM_TOKEN_ENV]: 'tok', [SHIM_PORT_ENV]: '70000' })).toThrow(
      ConfigError,
    );
  });

  it('selects a tier-1 agent with its default command', () => {
    const config = loadConfig({ [SHIM_TOKEN_ENV]: 'tok', [SHIM_AGENT_ENV]: 'claude-code' });
    expect(config.agent).toEqual({ kind: 'claude-code', command: 'claude-code-acp', args: [] });
  });

  it('falls back to echo for an unknown agent kind', () => {
    const config = loadConfig({ [SHIM_TOKEN_ENV]: 'tok', [SHIM_AGENT_ENV]: 'bogus' });
    expect(config.agent.kind).toBe('echo');
  });

  it('honors command and JSON-array args overrides', () => {
    const config = loadConfig({
      [SHIM_TOKEN_ENV]: 'tok',
      [SHIM_AGENT_ENV]: 'codex',
      [SHIM_AGENT_COMMAND_ENV]: 'npx',
      [SHIM_AGENT_ARGS_ENV]: '["-y","@agentclientprotocol/codex-acp"]',
    });
    expect(config.agent).toEqual({
      kind: 'codex',
      command: 'npx',
      args: ['-y', '@agentclientprotocol/codex-acp'],
    });
  });

  it('falls back to whitespace-split args when the override is not JSON', () => {
    const config = loadConfig({
      [SHIM_TOKEN_ENV]: 'tok',
      [SHIM_AGENT_ENV]: 'stream-json',
      [SHIM_AGENT_ARGS_ENV]: '-p --output-format stream-json',
    });
    expect(config.agent.args).toEqual(['-p', '--output-format', 'stream-json']);
  });
});
