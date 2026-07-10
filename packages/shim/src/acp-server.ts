/**
 * The northbound ACP agent server: binds one connected client (a JSON-RPC peer
 * over a WebSocket) to a southbound {@link Agent}.
 *
 * It routes the ACP client→agent requests (`initialize`, `session/new`,
 * `session/prompt`, `session/cancel`) onto the agent, and forwards the agent's
 * `session/update` streams and `session/request_permission` calls back onto the
 * peer. One server instance serves one connection; the shim creates a fresh agent
 * per connection so concurrent clients never share session state.
 */
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionUpdate,
} from './acp.js';
import type { Agent, AgentSession, PermissionRequest, SessionClient } from './agent.js';
import { JsonRpcErrorCode, RpcError, type JsonRpcPeer } from './jsonrpc.js';

/** Bind an ACP {@link Agent} to a JSON-RPC {@link JsonRpcPeer} for one client. */
export class AcpAgentServer {
  readonly #peer: JsonRpcPeer;
  readonly #agent: Agent;
  readonly #sessions = new Map<string, AgentSession>();

  constructor(peer: JsonRpcPeer, agent: Agent) {
    this.#peer = peer;
    this.#agent = agent;
    peer.onRequest(AcpMethod.initialize, (params) => this.#initialize(params as InitializeRequest));
    peer.onRequest(AcpMethod.newSession, (params) => this.#newSession(params as NewSessionRequest));
    peer.onRequest(AcpMethod.prompt, (params) => this.#prompt(params as PromptRequest));
    peer.onNotification(AcpMethod.cancel, (params) => this.#cancel(params as CancelNotification));
  }

  /** Close every session, then release the agent's process (client disconnected). */
  close(): void {
    for (const session of this.#sessions.values()) session.close();
    this.#sessions.clear();
    this.#agent.close?.();
  }

  async #initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    // A subprocess adapter reports real capabilities only once its own southbound
    // `initialize` has completed; await readiness so the flags we surface here are
    // the agent's, not a placeholder.
    await this.#agent.ready?.();
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: this.#agent.capabilities,
      authMethods: [],
    };
  }

  async #newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    // The agent mints the id, so the client callbacks read it from a holder that
    // is filled once the session exists — a session that streams an update during
    // its own creation still resolves to the right id.
    const holder: { id: string } = { id: '' };
    const session = await this.#agent.newSession(
      this.#clientFor(() => holder.id),
      params,
    );
    holder.id = session.id;
    this.#sessions.set(session.id, session);
    return { sessionId: session.id };
  }

  async #prompt(params: PromptRequest): Promise<PromptResponse> {
    const session = this.#requireSession(params.sessionId);
    return session.prompt(params.prompt);
  }

  #cancel(params: CancelNotification): void {
    this.#sessions.get(params.sessionId)?.cancel();
  }

  /** The callbacks a session uses to reach this connection's client. */
  #clientFor(sessionId: () => string): SessionClient {
    return {
      sessionUpdate: (update: SessionUpdate) => {
        this.#peer.notify(AcpMethod.update, { sessionId: sessionId(), update });
      },
      requestPermission: (request: PermissionRequest): Promise<RequestPermissionResponse> =>
        this.#peer.request<RequestPermissionResponse>(AcpMethod.requestPermission, {
          sessionId: sessionId(),
          ...request,
        }),
    };
  }

  #requireSession(sessionId: string): AgentSession {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) {
      throw new RpcError({
        code: JsonRpcErrorCode.invalidParams,
        message: `unknown session: ${sessionId}`,
      });
    }
    return session;
  }
}
