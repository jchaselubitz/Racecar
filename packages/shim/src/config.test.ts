import { describe, expect, it } from 'vitest';
import { SHIM_DEFAULT_PORT, SHIM_PORT_ENV, SHIM_TOKEN_ENV } from './contract.js';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('requires a token', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({ [SHIM_TOKEN_ENV]: '' })).toThrow(ConfigError);
  });

  it('defaults the port and host', () => {
    const config = loadConfig({ [SHIM_TOKEN_ENV]: 'tok' });
    expect(config).toEqual({ token: 'tok', port: SHIM_DEFAULT_PORT, host: '0.0.0.0' });
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
});
