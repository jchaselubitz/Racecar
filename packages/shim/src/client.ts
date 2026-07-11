/**
 * The northbound ACP client: the shim as seen from a Racecar CLI.
 *
 * `racecar chat` and the rewired `racecar run` are ACP *clients* of the shim.
 * This is the mirror of {@link AcpAgentServer}: it issues the client→agent
 * requests (`initialize`, `session/new`, `session/prompt`, `session/cancel`, and
 * the Racecar `session/list` / `session/attach` extensions) and serves the
 * agent→client half — dispatching streamed `session/update` notifications to a
 * handler and answering `session/request_permission` via a resolver the caller
 * supplies (an interactive prompt in `racecar chat`, an auto-policy in a detached
 * run).
 *
 * Like every protocol piece here it rides a transport-agnostic {@link JsonRpcPeer},
 * so the same client drives a real WebSocket in the CLI and an in-memory link in
 * tests, with no WebSocket dependency of its own.
 */
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  type AgentCapabilities,
  type AttachSessionResponse,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeResponse,
  type ListSessionsResponse,
  type MailboxListRequest,
  type MailboxListResponse,
  type MailboxMarkReadResponse,
  type MailboxMessage,
  type MailboxPostRequest,
  type MailboxPostResponse,
  type MailboxUpdateNotification,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionSummary,
  type SessionUpdateNotification,
} from './acp.js';
import type { JsonRpcPeer } from './jsonrpc.js';

/** How a client resolves an incoming permission request. */
export type PermissionHandler = (
  request: RequestPermissionRequest,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

/** Callbacks a {@link AcpClient} delivers agent→client messages through. */
export interface AcpClientHandlers {
  /** A streamed update within a turn (for the session it names). */
  readonly onUpdate?: (notification: SessionUpdateNotification) => void;
  /** Resolve a permission request; defaults to declining (cancelled). */
  readonly onPermission?: PermissionHandler;
  /** A mailbox message was added or changed (Racecar extension). */
  readonly onMailboxUpdate?: (notification: MailboxUpdateNotification) => void;
}

/** Options for {@link AcpClient}. */
export interface AcpClientOptions {
  /** Capabilities this client advertises to the shim in `initialize`. */
  readonly clientCapabilities?: ClientCapabilities;
  readonly handlers?: AcpClientHandlers;
}

/**
 * An ACP client bound to one {@link JsonRpcPeer}. Construct it over a transport,
 * `initialize`, then create or attach to a session and prompt.
 */
export class AcpClient {
  readonly #peer: JsonRpcPeer;
  readonly #clientCapabilities: ClientCapabilities;
  #handlers: AcpClientHandlers;
  #agentCapabilities: AgentCapabilities = {};

  constructor(peer: JsonRpcPeer, options: AcpClientOptions = {}) {
    this.#peer = peer;
    this.#clientCapabilities = options.clientCapabilities ?? {};
    this.#handlers = options.handlers ?? {};
    peer.onNotification(AcpMethod.update, (params) => {
      this.#handlers.onUpdate?.(params as SessionUpdateNotification);
    });
    peer.onNotification(AcpMethod.mailboxUpdate, (params) => {
      this.#handlers.onMailboxUpdate?.(params as MailboxUpdateNotification);
    });
    peer.onRequest(AcpMethod.requestPermission, (params) => this.#permission(params));
  }

  /** Replace the update/permission handlers (e.g. once a session id is known). */
  setHandlers(handlers: AcpClientHandlers): void {
    this.#handlers = handlers;
  }

  /** The agent capabilities from the last {@link initialize}. */
  get agentCapabilities(): AgentCapabilities {
    return this.#agentCapabilities;
  }

  /** Negotiate the protocol and record the shim's capabilities. */
  async initialize(): Promise<InitializeResponse> {
    const result = await this.#peer.request<InitializeResponse>(AcpMethod.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: this.#clientCapabilities,
    });
    this.#agentCapabilities = result.agentCapabilities ?? {};
    return result;
  }

  /** Create a new run/session; returns its id. */
  async newSession(params: NewSessionRequest = {}): Promise<string> {
    const result = await this.#peer.request<NewSessionResponse>(AcpMethod.newSession, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
    return result.sessionId;
  }

  /** List the runs the shim currently owns (Racecar extension). */
  async listSessions(): Promise<readonly SessionSummary[]> {
    const result = await this.#peer.request<ListSessionsResponse>(AcpMethod.listSessions);
    return result.sessions;
  }

  /** Subscribe to an existing run; its transcript replays as updates first. */
  async attachSession(sessionId: string): Promise<SessionSummary> {
    const result = await this.#peer.request<AttachSessionResponse>(AcpMethod.attachSession, {
      sessionId,
    });
    return result.session;
  }

  /** Send a prompt turn; resolves when the turn stops. */
  prompt(sessionId: string, content: readonly ContentBlock[]): Promise<PromptResponse> {
    return this.#peer.request<PromptResponse>(AcpMethod.prompt, { sessionId, prompt: content });
  }

  /** Cancel the in-flight turn for a session (notification). */
  cancel(sessionId: string): void {
    this.#peer.notify(AcpMethod.cancel, { sessionId });
  }

  /** List the sandbox's durable mailbox messages (Racecar extension). */
  async mailboxList(filter: MailboxListRequest = {}): Promise<readonly MailboxMessage[]> {
    const result = await this.#peer.request<MailboxListResponse>(AcpMethod.mailboxList, filter);
    return result.messages;
  }

  /**
   * Post a user→agent mailbox message — an instruction, or a reply (pass
   * `inReplyTo`). Durable; every connection observes it (Racecar extension).
   */
  async mailboxPost(params: MailboxPostRequest): Promise<MailboxMessage> {
    const result = await this.#peer.request<MailboxPostResponse>(AcpMethod.mailboxPost, params);
    return result.message;
  }

  /** Mark mailbox messages read; returns the ones whose state changed. */
  async mailboxMarkRead(messageIds: readonly string[]): Promise<readonly MailboxMessage[]> {
    const result = await this.#peer.request<MailboxMarkReadResponse>(AcpMethod.mailboxMarkRead, {
      messageIds,
    });
    return result.messages;
  }

  async #permission(params: unknown): Promise<RequestPermissionResponse> {
    const request = params as RequestPermissionRequest;
    if (this.#handlers.onPermission === undefined) {
      return { outcome: { outcome: 'cancelled' } };
    }
    return this.#handlers.onPermission(request);
  }
}

/** Build the content blocks for the common single-text-prompt case. */
export function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}
