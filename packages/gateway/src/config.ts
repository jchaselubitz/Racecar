import { randomUUID } from 'node:crypto';
export interface GatewayConfig {
  backendUrl: string;
  /**
   * Ordinary Overlord bearer credential (a `USER_TOKEN`, minted via
   * `ovld user-token create` or an OAuth-issued token). Replaces the old
   * bespoke gateway credential; rotating it must not change the target, which
   * is keyed by `deviceFingerprint`.
   */
  token: string;
  /**
   * Stable, opaque device fingerprint for this logical gateway execution
   * target. Generated once when provisioning the gateway and kept unchanged
   * across restarts, image rebuilds, redeploys, and token rotation so the
   * plain runner surface keeps reusing the same Overlord device/target row.
   * See planning/gateway-device-fingerprint-decision.md.
   */
  deviceFingerprint: string;
  /** Persistent host/volume directory containing Racecar and gateway state. */
  stateDirectory: string;
  instanceId: string;
  pollMs: number;
  port: number;
}
const required = (name: string, env: NodeJS.ProcessEnv): string => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const positive = (name: string, value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${name} must be a positive number`);
  return parsed;
};
export function loadConfig(env = process.env): GatewayConfig {
  return {
    backendUrl: required('OVERLORD_BACKEND_URL', env).replace(/\/$/, ''),
    token: required('OVERLORD_USER_TOKEN', env),
    deviceFingerprint: required('RACECAR_GATEWAY_DEVICE_FINGERPRINT', env),
    stateDirectory: required('RACECAR_GATEWAY_STATE_DIR', env),
    instanceId: env.RACECAR_GATEWAY_INSTANCE_ID ?? randomUUID(),
    pollMs: positive('RACECAR_GATEWAY_POLL_MS', env.RACECAR_GATEWAY_POLL_MS, 5000),
    port: positive('PORT', env.PORT, 8080),
  };
}
