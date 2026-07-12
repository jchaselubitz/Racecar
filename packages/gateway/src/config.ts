import { randomUUID } from 'node:crypto';
export interface GatewayConfig {
  backendUrl: string;
  token: string;
  executionTargetId: string;
  instanceId: string;
  pollMs: number;
  port: number;
  launchCommand: string;
  integrationRepo?: string;
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
    token: required('OVERLORD_GATEWAY_TOKEN', env),
    executionTargetId: required('OVERLORD_EXECUTION_TARGET_ID', env),
    instanceId: env.RACECAR_GATEWAY_INSTANCE_ID ?? randomUUID(),
    pollMs: positive('RACECAR_GATEWAY_POLL_MS', env.RACECAR_GATEWAY_POLL_MS, 5000),
    port: positive('PORT', env.PORT, 8080),
    launchCommand: required('RACECAR_GATEWAY_LAUNCH_COMMAND', env),
    ...(env.RACECAR_INTEGRATION_REPO ? { integrationRepo: env.RACECAR_INTEGRATION_REPO } : {}),
  };
}
