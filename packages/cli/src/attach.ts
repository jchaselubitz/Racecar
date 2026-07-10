/**
 * `racecar attach <sandbox>` — bridge the local terminal to a sandbox's named
 * tmux session over a provider PTY.
 *
 * The bridge does four things:
 *  - **stream**: the local terminal is put in raw mode so keystrokes flow to the
 *    PTY unmodified and the PTY's bytes are written straight to stdout;
 *  - **resize**: on `SIGWINCH` the local terminal's new size is pushed to the
 *    PTY, which is the tmux client's terminal, so tmux reflows;
 *  - **detach**: tmux's own `Ctrl-b d` exits the client cleanly (exit, no
 *    error), which ends the PTY and returns control to the shell;
 *  - **reconnect**: a dropped connection (a slept laptop, a network blip)
 *    surfaces as a PTY error rather than a clean exit, so the bridge restarts
 *    the sandbox if needed and reattaches to the still-running tmux session
 *    (which survives client disconnect — Stage 0).
 */
import type { ProviderPty, PtyExit, SandboxProvider } from '@racecar/core';
import { TMUX_SESSION, attachSessionScript } from '@racecar/core';

/** Refresh the sandbox activity timer while attached so a long watch stays alive. */
const HEARTBEAT_INTERVAL_MS = 60_000;
/** Reconnect attempts after a dropped connection before giving up. */
const MAX_RECONNECTS = 5;
/** Base backoff between reconnect attempts; doubles each try. */
const RECONNECT_BASE_MS = 500;

/** Options for {@link attachToSandbox}. */
export interface AttachOptions {
  /** Directory the tmux session starts in when it must be created. */
  readonly startDir?: string;
  /** Session name to attach to; defaults to the standard per-sandbox session. */
  readonly session?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Attach the current process's terminal to a sandbox's tmux session until the
 * user detaches or reconnection is exhausted. Returns when the session is
 * detached (or given up on); it does not kill the in-sandbox tmux session, so a
 * run keeps executing after detach.
 */
export async function attachToSandbox(
  provider: SandboxProvider,
  sandboxId: string,
  options: AttachOptions = {},
): Promise<void> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const interactive = stdin.isTTY === true;
  const session = options.session ?? TMUX_SESSION;

  const columns = (): number => stdout.columns ?? 80;
  const rows = (): number => stdout.rows ?? 24;

  let current: ProviderPty | undefined;
  const onStdin = (chunk: Buffer): void => {
    void current?.sendInput(chunk).catch(() => {});
  };
  const onResize = (): void => {
    void current?.resize(columns(), rows()).catch(() => {});
  };
  const restoreRawMode = (): void => {
    if (interactive && stdin.isTTY === true) stdin.setRawMode(false);
  };
  const notice = (message: string): void => {
    stdout.write(`\r\n[racecar] ${message}\r\n`);
  };

  // One PTY connection: launch tmux inside it, heartbeat while it lives, and
  // resolve with how it ended so the caller can decide whether to reconnect.
  const connectOnce = async (): Promise<PtyExit> => {
    const pty = await provider.createPty(sandboxId, {
      id: `racecar-attach-${process.pid}-${Date.now()}`,
      cols: columns(),
      rows: rows(),
      ...(options.startDir !== undefined ? { cwd: options.startDir } : {}),
      onData: (data) => {
        stdout.write(Buffer.from(data));
      },
    });
    current = pty;
    const heartbeat = setInterval(() => {
      void provider.heartbeat(sandboxId).catch(() => {});
    }, HEARTBEAT_INTERVAL_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();
    try {
      // The provider PTY starts a shell; send the attach command as input. `exec`
      // replaces the shell with tmux so a detach ends the PTY with a clean exit.
      await pty.sendInput(`${attachSessionScript(options.startDir, session)}\n`);
      return await pty.wait();
    } finally {
      clearInterval(heartbeat);
      current = undefined;
      await pty.disconnect().catch(() => {});
    }
  };

  if (interactive) stdin.setRawMode(true);
  stdin.resume();
  stdin.on('data', onStdin);
  process.on('SIGWINCH', onResize);
  process.once('exit', restoreRawMode);

  notice(`attaching to ${sandboxId} (tmux '${session}'). Detach with Ctrl-b d.`);
  try {
    for (let attempt = 0; ; attempt += 1) {
      // A sandbox that auto-stopped or slept must be restarted before reattaching.
      const sandbox = await provider.getSandbox(sandboxId);
      if (sandbox === null) throw new Error(`sandbox '${sandboxId}' not found`);
      if (sandbox.state === 'stopped' || sandbox.state === 'archived') {
        notice(`sandbox is ${sandbox.state}; starting…`);
        await provider.startSandbox(sandboxId);
      }

      const exit = await connectOnce();
      if (exit.error === undefined) {
        notice(`detached from ${sandboxId}.`);
        return;
      }
      if (attempt >= MAX_RECONNECTS) {
        notice(`connection lost (${exit.error}); gave up after ${MAX_RECONNECTS} reconnects.`);
        return;
      }
      const delay = RECONNECT_BASE_MS * 2 ** attempt;
      notice(`connection lost (${exit.error}); reconnecting in ${(delay / 1000).toFixed(1)}s…`);
      await sleep(delay);
    }
  } finally {
    stdin.removeListener('data', onStdin);
    process.removeListener('SIGWINCH', onResize);
    process.removeListener('exit', restoreRawMode);
    restoreRawMode();
    stdin.pause();
  }
}
