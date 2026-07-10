/**
 * The shim daemon.
 *
 * Started detached (in its own tmux session) at sandbox boot, it resolves its
 * config from the injected environment, serves ACP over the WebSocket on the
 * shim port, and runs until signalled. It logs newline-delimited JSON to stdout
 * so a supervising `racecar` can tail it, and it fails loudly (non-zero exit)
 * when the per-sandbox token is missing rather than serving unauthenticated.
 */
import { buildAgentFactory } from './agents.js';
import { ConfigError, loadConfig } from './config.js';
import { ShimServer, type ShimLogEvent } from './server.js';

function log(event: ShimLogEvent): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

/** Start the daemon; resolves with a stop function once it is listening. */
export async function startDaemon(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const config = loadConfig(env);
  log({ level: 'info', msg: 'agent selected', data: { kind: config.agent.kind } });
  const server = new ShimServer({
    token: config.token,
    port: config.port,
    host: config.host,
    agentFactory: buildAgentFactory(config.agent, undefined, env),
    onLog: log,
  });
  const { port } = await server.listen();
  return { port, stop: () => server.close() };
}

/**
 * Boot the daemon and install signal handlers. Resolves once listening; the
 * process then stays alive until SIGINT/SIGTERM. This is the function the `bin`
 * entry invokes. A missing token exits with EX_CONFIG (78) rather than throwing.
 */
export async function runDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  let handle: { stop: () => Promise<void> };
  try {
    handle = await startDaemon(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      log({ level: 'warn', msg: 'startup failed', data: { error: error.message } });
      process.exitCode = 78; // EX_CONFIG: unrecoverable configuration error.
      return;
    }
    throw error;
  }
  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log({ level: 'info', msg: 'shutting down', data: { signal } });
    void handle.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
