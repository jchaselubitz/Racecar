/**
 * The northbound server for shim-owned runs: binds one connected client (a
 * JSON-RPC peer over a WebSocket) to the shared {@link RunRegistry}.
 *
 * This is the run-aware counterpart of {@link AcpAgentServer}. Base ACP flows
 * through unchanged — `initialize`, `session/new`, `session/prompt`,
 * `session/cancel` — but a `session/new` here creates a *shared* run that outlives
 * this connection, and two Racecar extensions let clients converge on one run:
 * `session/list` enumerates the daemon's runs, and `session/attach` subscribes
 * this connection to an existing run (transcript replayed, then live). That is how
 * `racecar chat` joins the run `racecar run` started, so both — and the tmux
 * mirror `racecar attach` watches — describe the same session.
 *
 * One server instance serves one connection. On disconnect it drops only this
 * connection's observers and closes only the runs it exclusively owns; the shared
 * agent and any run another client is still watching stay up.
 */
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  type AttachSessionRequest,
  type AttachSessionResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsResponse,
  type MailboxListRequest,
  type MailboxListResponse,
  type MailboxMarkReadRequest,
  type MailboxMarkReadResponse,
  type MailboxMessage,
  type MailboxPostRequest,
  type MailboxPostResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionUpdate,
} from './acp.js';
import type { PermissionRequest } from './agent.js';
import { JsonRpcErrorCode, RpcError, type JsonRpcPeer } from './jsonrpc.js';
import type { Mailbox } from './mailbox.js';
import type { PermissionResponder, Run, RunRegistry } from './runs.js';

/** Bind the shared {@link RunRegistry} to a JSON-RPC {@link JsonRpcPeer}. */
export class RunAgentServer {
  readonly #peer: JsonRpcPeer;
  readonly #registry: RunRegistry;
  readonly #mailbox: Mailbox | undefined;
  /** Runs this connection created (and so exclusively owns): closed on disconnect. */
  readonly #owned = new Set<string>();
  /** Unsubscribes for every run this connection observes, keyed by run id. */
  readonly #subscriptions = new Map<string, () => void>();
  /** Unsubscribe from mailbox updates, dropped on disconnect. */
  #mailboxUnsubscribe: (() => void) | undefined;

  constructor(peer: JsonRpcPeer, registry: RunRegistry, mailbox?: Mailbox) {
    this.#peer = peer;
    this.#registry = registry;
    this.#mailbox = mailbox;
    peer.onRequest(AcpMethod.initialize, (params) => this.#initialize(params as InitializeRequest));
    peer.onRequest(AcpMethod.newSession, (params) => this.#newSession(params as NewSessionRequest));
    peer.onRequest(AcpMethod.prompt, (params) => this.#prompt(params as PromptRequest));
    peer.onRequest(AcpMethod.listSessions, () => this.#list());
    peer.onRequest(AcpMethod.attachSession, (params) =>
      this.#attach(params as AttachSessionRequest),
    );
    peer.onNotification(AcpMethod.cancel, (params) => this.#cancel(params as CancelNotification));
    if (mailbox !== undefined) {
      peer.onRequest(AcpMethod.mailboxList, (params) =>
        this.#mailboxListMessages(params as MailboxListRequest | undefined),
      );
      peer.onRequest(AcpMethod.mailboxPost, (params) => this.#mailboxPost(params as MailboxPostRequest));
      peer.onRequest(AcpMethod.mailboxMarkRead, (params) =>
        this.#mailboxMarkRead(params as MailboxMarkReadRequest),
      );
      // Every connection is subscribed to the shared mailbox, so a message posted
      // on any socket — or by the agent — reaches all of them live. A client that
      // wants the backlog too calls `mailbox/list` first, then stays live on this.
      this.#mailboxUnsubscribe = mailbox.observe((message) => this.#forwardMailbox(message));
    }
  }

  /** Drop this connection's observers and close the runs it exclusively owns. */
  close(): void {
    for (const unsubscribe of this.#subscriptions.values()) unsubscribe();
    this.#subscriptions.clear();
    this.#mailboxUnsubscribe?.();
    this.#mailboxUnsubscribe = undefined;
    for (const runId of this.#owned) this.#registry.get(runId)?.close();
    this.#owned.clear();
  }

  async #initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    await this.#registry.ready();
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: this.#registry.capabilities,
      authMethods: [],
    };
  }

  async #newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const run = await this.#registry.createRun(params);
    this.#owned.add(run.id);
    this.#subscribe(run);
    return { sessionId: run.id };
  }

  #list(): ListSessionsResponse {
    return { sessions: this.#registry.list() };
  }

  #attach(params: AttachSessionRequest): AttachSessionResponse {
    const run = this.#requireRun(params.sessionId);
    this.#subscribe(run);
    return { session: run.summary() };
  }

  async #prompt(params: PromptRequest): Promise<PromptResponse> {
    const run = this.#requireRun(params.sessionId);
    return run.prompt(params.prompt, this.#responder(run.id));
  }

  #cancel(params: CancelNotification): void {
    this.#registry.get(params.sessionId)?.cancel();
  }

  /** Subscribe this connection to a run's updates (idempotent per run). */
  #subscribe(run: Run): void {
    if (this.#subscriptions.has(run.id)) return;
    const forward = (update: SessionUpdate): void => {
      this.#peer.notify(AcpMethod.update, { sessionId: run.id, update });
    };
    this.#subscriptions.set(run.id, run.observe(forward));
  }

  /** The permission responder for turns this connection initiates, on `runId`. */
  #responder(runId: string): PermissionResponder {
    return {
      requestPermission: (request: PermissionRequest): Promise<RequestPermissionResponse> =>
        this.#peer.request<RequestPermissionResponse>(AcpMethod.requestPermission, {
          sessionId: runId,
          ...request,
        }),
    };
  }

  #mailboxListMessages(params: MailboxListRequest | undefined): MailboxListResponse {
    return { messages: this.#requireMailbox().list(params ?? {}) };
  }

  #mailboxPost(params: MailboxPostRequest): MailboxPostResponse {
    const message = this.#requireMailbox().post({
      text: params.text,
      ...(params.kind !== undefined ? { kind: params.kind } : {}),
      ...(params.sessionId !== undefined ? { sessionId: params.sessionId } : {}),
      ...(params.inReplyTo !== undefined ? { inReplyTo: params.inReplyTo } : {}),
    });
    return { message };
  }

  #mailboxMarkRead(params: MailboxMarkReadRequest): MailboxMarkReadResponse {
    return { messages: this.#requireMailbox().markRead(params.messageIds) };
  }

  #forwardMailbox(message: MailboxMessage): void {
    this.#peer.notify(AcpMethod.mailboxUpdate, { message });
  }

  #requireMailbox(): Mailbox {
    if (this.#mailbox === undefined) {
      throw new RpcError({
        code: JsonRpcErrorCode.methodNotFound,
        message: 'mailbox is not enabled on this shim',
      });
    }
    return this.#mailbox;
  }

  #requireRun(sessionId: string): Run {
    const run = this.#registry.get(sessionId);
    if (run === undefined) {
      throw new RpcError({
        code: JsonRpcErrorCode.invalidParams,
        message: `unknown session: ${sessionId}`,
      });
    }
    return run;
  }
}
