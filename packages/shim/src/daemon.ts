/**
 * The shim daemon.
 *
 * Started detached (in its own tmux session) at sandbox boot, it resolves its
 * config from the injected environment, serves ACP over the WebSocket on the
 * shim port, and runs until signalled. It logs newline-delimited JSON to stdout
 * so a supervising `racecar` can tail it, and it fails loudly (non-zero exit)
 * when the per-sandbox token is missing rather than serving unauthenticated.
 */
import { buildAgent } from './agents.js';
import { ConfigError, loadConfig } from './config.js';
import { deliveryTierOf } from './contract.js';
import { MailboxDelivery } from './delivery.js';
import { captureGit } from './git.js';
import { Mailbox, fileMailboxPersistence } from './mailbox.js';
import { createTranscriptMirror, fileTmuxSinks } from './mirror.js';
import { RunAgentServer } from './run-server.js';
import { RunRegistry } from './runs.js';
import { ShimServer, type ShimLogEvent } from './server.js';

function log(event: ShimLogEvent): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

/** Start the daemon; resolves with a stop function once it is listening. */
export async function startDaemon(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ port: number; stop: () => Promise<void> }> {
  const config = loadConfig(env);
  log({
    level: 'info',
    msg: 'agent selected',
    data: { kind: config.agent.kind, deliveryTier: deliveryTierOf(config.agent.kind) },
  });
  // One durable mailbox for the whole sandbox, replayed from its on-disk log so a
  // stop/start returns to the exact prior state. Shared across connections like
  // the run registry, so a question and its reply meet even on different sockets.
  const mailbox = new Mailbox({ persistence: fileMailboxPersistence(env) });
  // One shared agent and one run registry for the whole daemon, so every
  // connection sees the same runs — the pivot to shim-owned run state. Each run's
  // transcript is mirrored into the `racecar` tmux session an attach watches, and
  // runs post completions/questions to (and are driven from) the mailbox.
  const registry = new RunRegistry({
    agent: buildAgent(config.agent, undefined, env),
    onTranscript: createTranscriptMirror(fileTmuxSinks(env)),
    captureGit,
    mailbox,
  });
  // Route the mailbox's user→agent traffic to runs, per tier (mid-run injection
  // for tier 1/2, run-boundary prepend for tier 3), bootstrapping a run when an
  // instruction arrives at a sandbox with none yet.
  new MailboxDelivery(mailbox, registry);
  const server = new ShimServer({
    token: config.token,
    port: config.port,
    host: config.host,
    connect: (peer) => new RunAgentServer(peer, registry, mailbox),
    onLog: log,
  });
  const { port } = await server.listen();
  return {
    port,
    stop: async () => {
      await server.close();
      registry.close();
    },
  };
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
