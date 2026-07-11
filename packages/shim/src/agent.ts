/**
 * The southbound agent seam.
 *
 * Northbound, the shim serves ACP over a WebSocket (see {@link AcpAgentServer}).
 * Southbound, it drives an {@link Agent}: the actual thing answering prompts.
 * This interface is the tier boundary — a tier-1 adapter wraps a real ACP agent
 * (Claude Code / Codex), a tier-2 adapter bridges a stream-json agent — and both
 * arrive in the next objective. This module defines the seam and ships one
 * built-in {@link EchoAgent} so the transport, auth, and session plumbing are
 * end-to-end runnable and testable now, before any real agent is wired in.
 */
import type {
  AgentCapabilities,
  ContentBlock,
  NewSessionRequest,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionUpdate,
} from './acp.js';
import { promptText } from './acp.js';

/**
 * The callbacks an {@link AgentSession} uses to talk back to the connected ACP
 * client: stream updates during a turn, and ask the user to authorize an action.
 * The server implements this by forwarding onto the northbound JSON-RPC peer.
 */
export interface SessionClient {
  /** Emit one streamed `session/update` for this session. */
  sessionUpdate(update: SessionUpdate): void;
  /** Ask the client to resolve a permission request; awaits the user's choice. */
  requestPermission(request: PermissionRequest): Promise<RequestPermissionResponse>;
}

/** A permission request minus the sessionId (the session supplies its own). */
export type PermissionRequest = Omit<RequestPermissionRequest, 'sessionId'>;

/** One live conversation with an agent. Created per `session/new`. */
export interface AgentSession {
  /** The session id echoed to the client and carried by later calls. */
  readonly id: string;
  /** Run one prompt turn; resolve when it stops, with the stop reason. */
  prompt(content: readonly ContentBlock[]): Promise<PromptResponse>;
  /**
   * Deliver a user message *into the in-flight turn* — mid-run injection — if the
   * agent's protocol supports it (the tier-1/tier-2 path). Returns `true` when the
   * message was accepted into the running turn. A tier that cannot inject omits
   * this method (or returns `false`), and the shim instead queues the message and
   * prepends it to the next prompt (the tier-3, PTY-only, run-boundary path). It is
   * only meaningful while a turn is in flight; with no turn running it returns
   * `false` so the caller queues the message for the next turn.
   */
  inject?(content: readonly ContentBlock[]): boolean;
  /** Best-effort cancel of the in-flight turn (maps to `session/cancel`). */
  cancel(): void;
  /** Release any resources; called when the client disconnects. */
  close(): void;
}

/** A southbound agent: advertises capabilities and mints sessions. */
export interface Agent {
  /**
   * Capabilities surfaced northbound in the `initialize` response. For an agent
   * that starts a subprocess ({@link './acp-client.js'}), these are only valid
   * once {@link Agent.ready} resolves — the server awaits it before `initialize`.
   */
  readonly capabilities: AgentCapabilities;
  /**
   * Resolve when the agent is ready to report {@link Agent.capabilities} and mint
   * sessions. Optional: a synchronous in-process agent (e.g. {@link EchoAgent})
   * omits it. A subprocess adapter uses it to await the southbound `initialize`
   * handshake, and rejects it if the agent process dies before coming up.
   */
  ready?(): Promise<void>;
  /** Create a new session bound to `client`'s callbacks. */
  newSession(
    client: SessionClient,
    params: NewSessionRequest,
  ): Promise<AgentSession> | AgentSession;
  /**
   * Release process-level resources (kill the subprocess, close the pipe).
   * Called once when the connection this agent serves closes, after every
   * {@link AgentSession.close}. Optional for agents that own nothing to release.
   */
  close?(): void;
}

/** A factory producing a fresh {@link Agent} per client connection. */
export type AgentFactory = () => Agent;

let sessionCounter = 0;

/** Generate a session id unique within a daemon process. */
function nextSessionId(): string {
  sessionCounter += 1;
  return `sess-${Date.now().toString(36)}-${sessionCounter.toString(36)}`;
}

/**
 * A stub agent that echoes each prompt back as a single streamed assistant
 * message and ends the turn. It exercises the full northbound path — session
 * creation, prompt handling, `session/update` streaming, cancellation — without
 * any real model, so the shim is a valid, testable ACP agent before the tier-1
 * adapters exist. Real agents replace it by implementing {@link Agent}.
 */
export class EchoAgent implements Agent {
  readonly capabilities: AgentCapabilities = {
    loadSession: false,
    promptCapabilities: { image: false, audio: false, embeddedContext: false },
  };

  newSession(client: SessionClient): AgentSession {
    return new EchoSession(nextSessionId(), client);
  }
}

class EchoSession implements AgentSession {
  readonly id: string;
  readonly #client: SessionClient;

  constructor(id: string, client: SessionClient) {
    this.id = id;
    this.#client = client;
  }

  prompt(content: readonly ContentBlock[]): Promise<PromptResponse> {
    this.#client.sessionUpdate({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: `echo: ${promptText(content)}` },
    });
    return Promise.resolve({ stopReason: 'end_turn' });
  }

  // An echo turn completes synchronously, so there is nothing in flight to
  // cancel and no resource to release; a real agent implements both.
  cancel(): void {}
  close(): void {}
}
