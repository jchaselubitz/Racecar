import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const baseEnv = (): NodeJS.ProcessEnv => ({
  OVERLORD_BACKEND_URL: 'https://overlord.example/',
  OVERLORD_USER_TOKEN: 'user-token',
  RACECAR_GATEWAY_DEVICE_FINGERPRINT: 'a'.repeat(32),
  RACECAR_GATEWAY_STATE_DIR: '/data',
  RACECAR_GATEWAY_INSTANCE_ID: 'instance-123',
});

describe('loadConfig gatewayName', () => {
  it('reads GATEWAY_NAME as the trimmed device label', () => {
    const config = loadConfig({ ...baseEnv(), GATEWAY_NAME: '  west-gateway  ' });
    expect(config.gatewayName).toBe('west-gateway');
  });

  it('omits gatewayName when GATEWAY_NAME is unset or blank', () => {
    expect(loadConfig(baseEnv()).gatewayName).toBeUndefined();
    expect(loadConfig({ ...baseEnv(), GATEWAY_NAME: '   ' }).gatewayName).toBeUndefined();
  });
});
