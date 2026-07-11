import { describe, expect, it } from 'vitest';
import {
  SHIM_AGENT_ARGS_ENV,
  SHIM_AGENT_COMMAND_ENV,
  SHIM_AGENT_ENV,
  SHIM_DEFAULT_PORT,
  SHIM_PORT_ENV,
  SHIM_TOKEN_ENV,
} from './contract.js';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('requires a token', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ [SHIM_TOKEN_ENV]: '' })).toThrow(ConfigError);
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
