/**
 * Tier-1 southbound adapter: a real ACP agent running as a subprocess.
 *
 * The shim is northbound an ACP *agent*. Southbound, for a tier-1 agent, it is an
 * ACP *client* of a subprocess that itself speaks ACP over stdio — Claude Code via
 * its ACP adapter, or Codex via `@agentclientprotocol/codex-acp`. This adapter is
 * that client: it reuses the same {@link JsonRpcPeer} the northbound side uses,
 * now framed over the process's stdin/stdout ({@link AgentProcess}), and proxies
 * the ACP method set through. Because it is a faithful ACP-to-ACP proxy, it needs
 * no per-agent translation — the tier-1 contract is "already speaks ACP" — and the
 * agent's own capabilities are surfaced northbound unchanged (see {@link capabilities}).
 *
 * Session ids are shared, not remapped: the northbound session id *is* the
 * subprocess's session id, so `session/update` and `session/request_permission`
 * the subprocess emits (tagged with that id) route straight back to the right
 * northbound client with no translation table.
 */
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  type AgentCapabilities,
  type ClientCapabilities,
  type ContentBlock,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionRequest,
  type SessionUpdateNotification,
} from './acp.js';
import type { Agent, AgentSession, SessionClient } from './agent.js';
import { JsonRpcErrorCode, JsonRpcPeer, RpcError } from './jsonrpc.js';
import type { AgentProcess } from './stdio.js';

/** Options for a {@link ProcessAcpAgent}. */
export interface ProcessAcpAgentOptions {
  /**
   * Capabilities the shim advertises to the subprocess as *its* client. The shim
   * gates auth and renders prompts itself, so it claims no filesystem/terminal
   * client capabilities by default; the subprocess still streams updates and asks
   * for permission, which the shim forwards northbound.
   */
  readonly clientCapabilities?: ClientCapabilities;
}

/**
 * A tier-1 agent backed by an ACP subprocess. One instance per northbound
 * connection owns one subprocess; multiple northbound sessions share it (ACP
 * multiplexes sessions over one agent), and each is demuxed by session id.
 */
export class ProcessAcpAgent implements Agent {
  readonly #proc: AgentProcess;
  readonly #peer: JsonRpcPeer;
  /** Northbound client callbacks, keyed by the subprocess's session id. */
  readonly #clients = new Map<string, SessionClient>();
  readonly #ready: Promise<void>;
  #capabilities: AgentCapabilities = {};

  constructor(proc: AgentProcess, options: ProcessAcpAgentOptions = {}) {
    this.#proc = proc;
    this.#peer = new JsonRpcPeer((message) => proc.writeLine(message));
    proc.onLine((line) => void this.#peer.receive(line));
    // If the subprocess dies, fail every in-flight request (readiness, prompts)
    // instead of leaving northbound callers hung.
    proc.onExit((info) => {
      const how = info.signal ?? (info.code === null ? 'spawn failure' : `code ${info.code}`);
      this.#peer.close(`agent process exited (${how})`);
    });

    // Southbound, the shim receives the agent→client half of ACP: streamed
    // updates and permission prompts, both tagged with the subprocess session id.
    this.#peer.onNotification(AcpMethod.update, (params) => {
      const note = params as SessionUpdateNotification;
      this.#clients.get(note.sessionId)?.sessionUpdate(note.update);
    });
    this.#peer.onRequest(AcpMethod.requestPermission, (params) => {
      const request = params as RequestPermissionRequest;
      const client = this.#clients.get(request.sessionId);
      if (client === undefined) {
        throw new RpcError({
          code: JsonRpcErrorCode.invalidParams,
          message: `permission for unknown session: ${request.sessionId}`,
        });
      }
      const { sessionId: _id, ...rest } = request;
      return client.requestPermission(rest);
    });

    this.#ready = this.#initialize(options.clientCapabilities);
  }

  get capabilities(): AgentCapabilities {
    return this.#capabilities;
  }

  ready(): Promise<void> {
    return this.#ready;
  }

  async #initialize(clientCapabilities?: ClientCapabilities): Promise<void> {
    const result = await this.#peer.request<InitializeResponse>(AcpMethod.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: clientCapabilities ?? {},
    });
    // Surface the subprocess's own capabilities northbound unchanged — that is the
    // whole point of tier 1: what the real agent can do is what the client sees.
    this.#capabilities = result.agentCapabilities ?? {};
  }

  async newSession(client: SessionClient, params: NewSessionRequest): Promise<AgentSession> {
    await this.#ready;
    const result = await this.#peer.request<NewSessionResponse>(AcpMethod.newSession, {
      cwd: params.cwd,
      mcpServers: params.mcpServers ?? [],
    });
    const sessionId = result.sessionId;
    this.#clients.set(sessionId, client);
    return new ProcessAcpSession(sessionId, this.#peer, () => this.#clients.delete(sessionId));
  }

  close(): void {
    this.#peer.close('shim closing agent connection');
    this.#proc.kill();
  }
}

/** One session on a {@link ProcessAcpAgent}: proxies a turn to the subprocess. */
class ProcessAcpSession implements AgentSession {
  readonly id: string;
  readonly #peer: JsonRpcPeer;
  readonly #onClose: () => void;
  /** Whether a `session/prompt` turn is currently in flight (gates injection). */
  #turnInFlight = false;

  constructor(id: string, peer: JsonRpcPeer, onClose: () => void) {
    this.id = id;
    this.#peer = peer;
    this.#onClose = onClose;
  }

  async prompt(content: readonly ContentBlock[]): Promise<PromptResponse> {
    this.#turnInFlight = true;
    try {
      return await this.#peer.request<PromptResponse>(AcpMethod.prompt, {
        sessionId: this.id,
        prompt: content,
      });
    } finally {
      this.#turnInFlight = false;
    }
  }

  /**
   * Tier-1 mid-run injection: forward the user's message on the session's own ACP
   * channel so a native ACP agent folds it into the in-flight turn; its reaction
   * then streams back as ordinary `session/update` chunks on this same run. The
   * injected message is not a new shim-owned turn, so its `PromptResponse` is
   * discarded and its errors swallowed — a non-fatal injection must never crash
   * the run driving the actual turn. With no turn running it returns `false` so the
   * shim queues the message for the next prompt instead.
   */
  inject(content: readonly ContentBlock[]): boolean {
    if (!this.#turnInFlight) return false;
    void this.#peer
      .request<PromptResponse>(AcpMethod.prompt, { sessionId: this.id, prompt: content })
      .catch(() => undefined);
    return true;
  }

  cancel(): void {
    this.#peer.notify(AcpMethod.cancel, { sessionId: this.id });
  }

  close(): void {
    this.#onClose();
  }
}
