/**
 * Newline-delimited framing over a child process's stdio.
 *
 * The southbound adapters drive a real agent that runs as a subprocess inside the
 * sandbox: a tier-1 agent speaks ACP (JSON-RPC 2.0) over stdio, a tier-2 agent
 * speaks stream-json over stdio. Both are one JSON value per line, so this module
 * owns the one thing they share — spawning the process and turning its stdout byte
 * stream into whole lines (and a line into a stdin write) — while the protocol on
 * top lives in {@link './acp-client.js'} and {@link './stream-json.js'}.
 *
 * {@link AgentProcess} is the seam the adapters depend on, not `child_process`
 * directly, so a test can drive an adapter with an in-memory or scripted process
 * and no real binary. {@link spawnAgentProcess} is the production implementation.
 */
import { spawn } from 'node:child_process';

/** How to launch a southbound agent subprocess. */
export interface SpawnSpec {
  /** Executable to run (resolved via PATH), e.g. `claude-code-acp`. */
  readonly command: string;
  /** Arguments passed to the executable. */
  readonly args?: readonly string[];
  /** Working directory; defaults to the daemon's cwd. */
  readonly cwd?: string;
  /** Environment for the child; defaults to the daemon's own environment. */
  readonly env?: NodeJS.ProcessEnv;
}

/** Reason a process ended. */
export interface ExitInfo {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * A line-framed subprocess seam: write whole lines to its stdin, receive whole
 * lines from its stdout, observe stderr and exit. The adapters depend on this
 * interface rather than a concrete `ChildProcess` so they stay unit-testable.
 */
export interface AgentProcess {
  /** Write one message as a single `\n`-terminated line to the child's stdin. */
  writeLine(line: string): void;
  /** Register a handler invoked once per complete stdout line (newline stripped). */
  onLine(handler: (line: string) => void): void;
  /** Register a handler for raw stderr text (diagnostics; not line-framed). */
  onStderr(handler: (chunk: string) => void): void;
  /** Register a handler invoked once when the process exits. */
  onExit(handler: (info: ExitInfo) => void): void;
  /** Terminate the process (best-effort). */
  kill(): void;
}

/**
 * A reusable stdout-to-lines splitter. Bytes arrive in arbitrary chunks; this
 * buffers a partial trailing line until its newline shows up, so a JSON value
 * split across two `data` events is still delivered as one line.
 */
export class LineBuffer {
  #buffer = '';
  readonly #onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.#onLine = onLine;
  }

  /** Feed a chunk of stdout; emits every complete line it now contains. */
  push(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.length > 0) this.#onLine(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  /** Flush any buffered partial line (called at EOF). */
  flush(): void {
    const rest = this.#buffer.trim();
    this.#buffer = '';
    if (rest.length > 0) this.#onLine(rest);
  }
}

/**
 * Spawn a subprocess and wrap it as an {@link AgentProcess}. stdout is line-split
 * via {@link LineBuffer}; stdin gets a `\n` appended per {@link AgentProcess.writeLine}.
 * A spawn failure (bad command) surfaces through the exit handler with a null code,
 * so an adapter's readiness promise rejects rather than hanging.
 */
export function spawnAgentProcess(spec: SpawnSpec): AgentProcess {
  const child = spawn(spec.command, [...(spec.args ?? [])], {
    cwd: spec.cwd,
    env: spec.env ?? process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  const lineHandlers: ((line: string) => void)[] = [];
  const stderrHandlers: ((chunk: string) => void)[] = [];
  const exitHandlers: ((info: ExitInfo) => void)[] = [];

  const lines = new LineBuffer((line) => {
    for (const handler of lineHandlers) handler(line);
  });
  child.stdout.on('data', (chunk: string) => lines.push(chunk));
  child.stdout.on('end', () => lines.flush());
  child.stderr.on('data', (chunk: string) => {
    for (const handler of stderrHandlers) handler(chunk);
  });
  const emitExit = (info: ExitInfo): void => {
    for (const handler of exitHandlers) handler(info);
  };
  child.on('exit', (code, signal) => emitExit({ code, signal }));
  // `error` fires when the binary cannot be spawned at all; report it as an exit
  // with no code so adapters treat it as a dead process rather than waiting.
  child.on('error', () => emitExit({ code: null, signal: null }));

  return {
    writeLine(line: string): void {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    },
    onLine(handler): void {
      lineHandlers.push(handler);
    },
    onStderr(handler): void {
      stderrHandlers.push(handler);
    },
    onExit(handler): void {
      exitHandlers.push(handler);
    },
    kill(): void {
      child.kill();
    },
  };
}
