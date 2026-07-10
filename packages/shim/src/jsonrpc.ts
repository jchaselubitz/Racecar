/**
 * A minimal, transport-agnostic JSON-RPC 2.0 peer.
 *
 * ACP is JSON-RPC 2.0 in both directions: the client calls the agent
 * (`initialize`, `session/new`, `session/prompt`) and the agent calls back into
 * the client (`session/update`, `session/request_permission`). This peer models
 * exactly that symmetry — it can both issue requests and serve them — over any
 * message transport, so the same logic drives a WebSocket northbound and a pipe
 * southbound and stays unit-testable with an in-memory transport.
 *
 * The peer is framing-agnostic: it is handed already-separated messages (one
 * JSON value per {@link JsonRpcPeer.receive} call) and emits already-separated
 * messages through its `send` callback. WebSocket frames and newline-delimited
 * JSON both satisfy that contract, so no framing lives here.
 */

/** A JSON-RPC request/response id. */
export type JsonRpcId = number | string;

/** Standard JSON-RPC 2.0 error codes, plus the range reserved for the app. */
export const JsonRpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
} as const;

/** A JSON-RPC error object, as it appears on the wire and in {@link RpcError}. */
export interface JsonRpcErrorBody {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** Error thrown/rejected when a peer returns a JSON-RPC error response. */
export class RpcError extends Error {
  readonly code: number;
  readonly data: unknown;
  constructor(body: JsonRpcErrorBody) {
    super(body.message);
    this.name = 'RpcError';
    this.code = body.code;
    this.data = body.data;
  }
}

/** Handler for an incoming request; its resolved value becomes the result. */
export type RequestHandler = (params: unknown) => unknown;
/** Handler for an incoming notification (a request with no id: no reply). */
export type NotificationHandler = (params: unknown) => void | Promise<void>;

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
}

interface RawMessage {
  jsonrpc?: unknown;
  id?: JsonRpcId | null;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcErrorBody;
}

/** Whether a decoded message is a response (has result or error, no method). */
function isResponse(message: RawMessage): boolean {
  return (
    message.method === undefined && (message.result !== undefined || message.error !== undefined)
  );
}

/**
 * A bidirectional JSON-RPC 2.0 endpoint over a single message transport. Feed it
 * incoming messages with {@link receive}; it calls `send` for every outgoing
 * message. {@link close} rejects all in-flight requests so no caller hangs when
 * the transport drops.
 */
export class JsonRpcPeer {
  readonly #send: (message: string) => void;
  readonly #requestHandlers = new Map<string, RequestHandler>();
  readonly #notificationHandlers = new Map<string, NotificationHandler>();
  readonly #pending = new Map<JsonRpcId, Pending>();
  #nextId = 1;
  #closed = false;

  constructor(send: (message: string) => void) {
    this.#send = send;
  }

  /** Register a handler for an inbound request `method`. */
  onRequest(method: string, handler: RequestHandler): this {
    this.#requestHandlers.set(method, handler);
    return this;
  }

  /** Register a handler for an inbound notification `method`. */
  onNotification(method: string, handler: NotificationHandler): this {
    this.#notificationHandlers.set(method, handler);
    return this;
  }

  /** Issue a request and resolve with its result (or reject with {@link RpcError}). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('JSON-RPC peer is closed'));
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#write({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  /** Send a notification (fire-and-forget: no id, no reply). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#write({ jsonrpc: '2.0', method, ...(params !== undefined ? { params } : {}) });
  }

  /** Feed one raw inbound message (a single JSON value) into the peer. */
  async receive(raw: string): Promise<void> {
    let message: RawMessage;
    try {
      message = JSON.parse(raw) as RawMessage;
    } catch {
      this.#write({
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCode.parseError, message: 'parse error' },
      });
      return;
    }
    if (message === null || typeof message !== 'object') {
      this.#write({
        jsonrpc: '2.0',
        id: null,
        error: { code: JsonRpcErrorCode.invalidRequest, message: 'invalid request' },
      });
      return;
    }
    if (isResponse(message)) {
      this.#settle(message);
      return;
    }
    await this.#dispatch(message);
  }

  /** Reject every in-flight request and refuse new ones. */
  close(reason: string = 'JSON-RPC peer closed'): void {
    if (this.#closed) return;
    this.#closed = true;
    const error = new Error(reason);
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #settle(message: RawMessage): void {
    const id = message.id;
    if (id === undefined || id === null) return;
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (message.error !== undefined) pending.reject(new RpcError(message.error));
    else pending.resolve(message.result);
  }

  async #dispatch(message: RawMessage): Promise<void> {
    const method = typeof message.method === 'string' ? message.method : undefined;
    const id = message.id;
    const isNotification = id === undefined || id === null;
    if (method === undefined) {
      if (!isNotification) {
        this.#write({
          jsonrpc: '2.0',
          id,
          error: { code: JsonRpcErrorCode.invalidRequest, message: 'invalid request' },
        });
      }
      return;
    }
    if (isNotification) {
      const handler = this.#notificationHandlers.get(method);
      if (handler === undefined) return; // Unknown notifications are ignored per spec.
      try {
        await handler(message.params);
      } catch {
        // A notification has no reply channel; swallow to protect the peer loop.
      }
      return;
    }
    const handler = this.#requestHandlers.get(method);
    if (handler === undefined) {
      this.#write({
        jsonrpc: '2.0',
        id,
        error: { code: JsonRpcErrorCode.methodNotFound, message: `method not found: ${method}` },
      });
      return;
    }
    try {
      const result = await handler(message.params);
      this.#write({ jsonrpc: '2.0', id, result: result ?? null });
    } catch (error) {
      this.#write({ jsonrpc: '2.0', id, error: toErrorBody(error) });
    }
  }

  #write(message: Record<string, unknown>): void {
    this.#send(JSON.stringify(message));
  }
}

/** Map a thrown value onto a JSON-RPC error body, preserving {@link RpcError}. */
function toErrorBody(error: unknown): JsonRpcErrorBody {
  if (error instanceof RpcError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: JsonRpcErrorCode.internalError, message };
}
