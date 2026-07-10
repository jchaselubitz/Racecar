/**
 * Tier-2 southbound adapter: a stream-json agent, bridged to ACP.
 *
 * A tier-2 agent does *not* speak ACP. It speaks a line-delimited "stream-json"
 * protocol (the shape Claude Code emits under `--output-format stream-json` and
 * accepts under `--input-format stream-json`): one JSON envelope per line, a
 * `user` message in, `assistant` and `result` events out. This adapter translates
 * between that and the ACP {@link Agent} seam, so a stream-json agent presents
 * northbound *identically* to a tier-1 ACP agent — same `session/new`, same
 * streamed `session/update` chunks, same `stopReason`. That equivalence is the
 * point: it proves the tier boundary is real, and that adding a non-ACP agent is
 * a matter of writing a bridge, not of leaking a second protocol northbound.
 *
 * Scope of this reference: text turns. A stream-json agent has no native session
 * concept — the process *is* the conversation — so each ACP session owns its own
 * subprocess (multi-turn via streaming input). Tool calls and permission prompts
 * are out of scope here; a production bridge would map `tool_use`/`tool_result`
 * envelopes onto `tool_call` updates and `session/request_permission` the same way.
 */
import type { AgentCapabilities, ContentBlock, PromptResponse, StopReason } from './acp.js';
import { promptText } from './acp.js';
import type { Agent, AgentSession, SessionClient } from './agent.js';
import type { AgentProcess } from './stdio.js';

/** A stream-json envelope emitted by the agent on stdout (the subset we read). */
type StreamJsonEvent =
  | { readonly type: 'system'; readonly subtype?: string }
  | {
      readonly type: 'assistant';
      readonly message?: { readonly content?: readonly { type?: string; text?: string }[] };
    }
  | {
      readonly type: 'result';
      readonly subtype?: string;
      readonly is_error?: boolean;
      readonly result?: string;
    }
  | { readonly type: string };

/** Static capabilities a text-only stream-json bridge advertises northbound. */
const STREAM_JSON_CAPABILITIES: AgentCapabilities = {
  loadSession: false,
  promptCapabilities: { image: false, audio: false, embeddedContext: false },
};

let sessionCounter = 0;

function nextSessionId(): string {
  sessionCounter += 1;
  return `sj-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
}

/**
 * A tier-2 agent that bridges ACP to a stream-json subprocess. Each session spawns
 * its own process (see {@link StreamJsonSession}); capabilities are static, so no
 * process starts until the first `session/new`.
 */
export class StreamJsonAgent implements Agent {
  readonly capabilities = STREAM_JSON_CAPABILITIES;
  readonly #spawn: () => AgentProcess;
  readonly #sessions = new Set<StreamJsonSession>();

  /** @param spawn Launches one stream-json subprocess per session. */
  constructor(spawn: () => AgentProcess) {
    this.#spawn = spawn;
  }

  newSession(client: SessionClient): AgentSession {
    const session = new StreamJsonSession(nextSessionId(), client, this.#spawn(), () =>
      this.#sessions.delete(session),
    );
    this.#sessions.add(session);
    return session;
  }

  close(): void {
    for (const session of this.#sessions) session.close();
    this.#sessions.clear();
  }
}

interface InFlightTurn {
  readonly resolve: (response: PromptResponse) => void;
  /** Set when the client cancels; the terminating `result` then reports it. */
  cancelled: boolean;
}

/** One stream-json conversation: owns a subprocess, one turn at a time. */
class StreamJsonSession implements AgentSession {
  readonly id: string;
  readonly #client: SessionClient;
  readonly #proc: AgentProcess;
  readonly #onClose: () => void;
  #turn: InFlightTurn | null = null;
  #closed = false;

  constructor(id: string, client: SessionClient, proc: AgentProcess, onClose: () => void) {
    this.id = id;
    this.#client = client;
    this.#proc = proc;
    this.#onClose = onClose;
    proc.onLine((line) => this.#onLine(line));
    proc.onExit(() => this.#onExit());
  }

  prompt(content: readonly ContentBlock[]): Promise<PromptResponse> {
    if (this.#closed) return Promise.resolve({ stopReason: 'cancelled' });
    return new Promise<PromptResponse>((resolve) => {
      this.#turn = { resolve, cancelled: false };
      this.#proc.writeLine(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content: [{ type: 'text', text: promptText(content) }] },
        }),
      );
    });
  }

  cancel(): void {
    // stream-json has no cancel control message; the reference resolves the
    // in-flight turn as cancelled and stops forwarding its remaining output. The
    // subprocess keeps running for the next turn.
    if (this.#turn === null) return;
    this.#turn.cancelled = true;
    this.#finish('cancelled');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#proc.kill();
    this.#onClose();
  }

  #onLine(line: string): void {
    let event: StreamJsonEvent;
    try {
      event = JSON.parse(line) as StreamJsonEvent;
    } catch {
      return; // Non-JSON diagnostic noise on stdout is ignored.
    }
    // A cancelled turn stops forwarding output but still drains until its result.
    if (event.type === 'assistant' && this.#turn !== null && !this.#turn.cancelled) {
      const blocks = 'message' in event ? (event.message?.content ?? []) : [];
      for (const block of blocks) {
        if (block.type === 'text' && typeof block.text === 'string') {
          this.#client.sessionUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: block.text },
          });
        }
      }
      return;
    }
    if (event.type === 'result') {
      const isError = 'is_error' in event && event.is_error === true;
      this.#finish(isError ? 'refusal' : 'end_turn');
    }
  }

  #onExit(): void {
    // Process died mid-turn: end the turn rather than hang the northbound caller.
    this.#finish('cancelled');
  }

  /** Resolve the in-flight turn once, with `stopReason` (cancel wins if set). */
  #finish(stopReason: StopReason): void {
    const turn = this.#turn;
    if (turn === null) return;
    this.#turn = null;
    turn.resolve({ stopReason: turn.cancelled ? 'cancelled' : stopReason });
  }
}
