/**
 * Mirroring a shim-owned run into the tmux session `racecar attach` watches.
 *
 * A run is an ACP session — its live view is `racecar chat`. But the plan
 * requires the PTY view and the chat view to describe the *same* session, so the
 * shim also renders each run's streamed updates to a transcript file and opens a
 * tmux window that tails it, inside the `racecar` session an attach connects to.
 * The result: `racecar attach` shows the conversation as it streams, read-only,
 * while `racecar chat` drives it — one run, two supervisors.
 *
 * The rendering ({@link renderTranscriptLine}) is a pure function so it is unit
 * tested directly. The side effects — appending to a file, spawning tmux — are
 * injected ({@link MirrorSinks}), so the wiring is testable without a real tmux
 * and the daemon supplies the real implementations.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { RUN_TMUX_SESSION } from './contract.js';
import type { SessionUpdate } from './acp.js';
import type { TranscriptSink } from './runs.js';

/**
 * Render one streamed update as a human transcript line, or `undefined` for an
 * update with nothing to show. Kept deliberately plain: this is a terminal tail,
 * not a chat UI.
 */
export function renderTranscriptLine(update: SessionUpdate): string | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text' ? update.content.text : undefined;
    case 'agent_thought_chunk':
      return update.content.type === 'text' ? `(thinking) ${update.content.text}` : undefined;
    case 'user_message_chunk':
      return update.content.type === 'text' ? `> ${update.content.text}` : undefined;
    case 'tool_call':
      return `[tool ${update.status}] ${update.title}`;
    default:
      return undefined;
  }
}

/** The side effects a {@link createTranscriptMirror} needs, injected for tests. */
export interface MirrorSinks {
  /** Append a rendered line to the transcript for `runId`. */
  readonly append: (runId: string, line: string) => void;
  /** Ensure a tmux window tailing `runId`'s transcript exists (idempotent). */
  readonly ensureWindow: (runId: string) => void;
}

/**
 * A {@link TranscriptSink} that renders each update and mirrors it: appends to the
 * run's transcript file and, on the first line of a run, opens its tmux window.
 */
export function createTranscriptMirror(sinks: MirrorSinks): TranscriptSink {
  const started = new Set<string>();
  return (runId, update) => {
    const line = renderTranscriptLine(update);
    if (line === undefined) return;
    if (!started.has(runId)) {
      started.add(runId);
      sinks.ensureWindow(runId);
    }
    sinks.append(runId, line);
  };
}

/** Absolute path of a run's transcript file inside the sandbox. */
export function transcriptPath(home: string, runId: string): string {
  return `${home}/.racecar/runs/${runId}.transcript`;
}

/**
 * The production {@link MirrorSinks}: append to `~/.racecar/runs/<id>.transcript`
 * and open a `tail -F` tmux window in the `racecar` session. tmux failures are
 * swallowed — a missing tmux must degrade the mirror, never break the run.
 */
export function fileTmuxSinks(env: NodeJS.ProcessEnv = process.env): MirrorSinks {
  const home = env.HOME ?? '/root';
  const dir = `${home}/.racecar/runs`;
  return {
    append: (runId, line) => {
      try {
        mkdirSync(dir, { recursive: true });
        appendFileSync(transcriptPath(home, runId), `${line}\n`);
      } catch {
        // A transcript we cannot write is a degraded mirror, not a failed run.
      }
    },
    ensureWindow: (runId) => {
      const path = transcriptPath(home, runId);
      // `new-window` in the run session, creating the session detached if absent.
      // `tail -F` follows the file even though it is (re)created after the window.
      try {
        spawn(
          'sh',
          [
            '-c',
            `tmux has-session -t ${RUN_TMUX_SESSION} 2>/dev/null || tmux new-session -d -s ${RUN_TMUX_SESSION}; ` +
              `tmux new-window -t ${RUN_TMUX_SESSION} -n ${shPart(runId)} "tail -n +1 -F ${shPart(path)}"`,
          ],
          { stdio: 'ignore', detached: true, env },
        ).unref();
      } catch {
        // No tmux (or a spawn failure): the chat view still works; attach just
        // will not show this run.
      }
    },
  };
}

/** Quote a value as a single shell word (safe run ids and paths only, but be strict). */
function shPart(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
