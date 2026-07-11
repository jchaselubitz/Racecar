/**
 * The shim WebSocket server: the sandbox-side endpoint a third-party ACP client
 * reaches over the preview URL.
 *
 * Each accepted connection gets its own JSON-RPC peer, its own {@link Agent}
 * (via the factory), and its own {@link AcpAgentServer}, so the measured
 * multi-client fan-in (two clients on one preview URL, from the Stage 0 spike)
 * means `racecar chat` and a third-party editor supervise a sandbox without
 * sharing session state. Upgrades are authenticated before the WebSocket is
 * accepted: a request with no valid per-sandbox token is refused at the HTTP
 * layer with a 401/403 and never becomes a socket.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { AcpAgentServer } from './acp-server.js';
import { EchoAgent, type AgentFactory } from './agent.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { authenticate, tokenSubprotocol } from './token.js';

/** A per-connection binding the server tears down when the socket closes. */
export interface Connection {
  close(): void;
}

/** Binds a fresh JSON-RPC peer to whatever serves it (an ACP agent, a run store). */
export type ConnectionHandler = (peer: JsonRpcPeer) => Connection;

/** Options for a {@link ShimServer}. */
export interface ShimServerOptions {
  /** Per-sandbox token every connection must present. */
  readonly token: string;
  /** Port to listen on. Use 0 to let the OS pick (tests). */
  readonly port: number;
  /** Interface to bind; defaults to all interfaces. */
  readonly host?: string;
  /**
   * Bind each connection to its server. Defaults to a per-connection
   * {@link AcpAgentServer} over {@link agentFactory} (the isolated-session path).
   * The daemon overrides this to share one {@link RunRegistry} across connections
   * so `racecar run` and `racecar chat` converge on the same run.
   */
  readonly connect?: ConnectionHandler;
  /** Produces the agent for each connection; defaults to {@link EchoAgent}. */
  readonly agentFactory?: AgentFactory;
  /** Structured log sink; defaults to no-op. */
  readonly onLog?: (event: ShimLogEvent) => void;
}

/** A structured server log event. */
export interface ShimLogEvent {
  readonly level: 'info' | 'warn';
  readonly msg: string;
  readonly data?: Record<string, unknown>;
}

/** A running shim WebSocket server. */
export class ShimServer {
  readonly #token: string;
  readonly #host: string;
  readonly #port: number;
  readonly #connect: ConnectionHandler;
  readonly #log: (event: ShimLogEvent) => void;
  readonly #http: Server;
  readonly #wss: WebSocketServer;
  readonly #connections = new Set<WebSocket>();

  constructor(options: ShimServerOptions) {
    this.#token = options.token;
    this.#host = options.host ?? '0.0.0.0';
    this.#port = options.port;
    const agentFactory = options.agentFactory ?? (() => new EchoAgent());
    this.#connect = options.connect ?? ((peer) => new AcpAgentServer(peer, agentFactory()));
    this.#log = options.onLog ?? (() => {});
    this.#http = createServer((_req, res) => {
      // The only supported route is the WebSocket upgrade; a plain GET is a
      // liveness probe answered without leaking anything about the shim.
      res.writeHead(426, { 'content-type': 'text/plain', connection: 'close' });
      res.end('upgrade required\n');
    });
    this.#wss = new WebSocketServer({
      noServer: true,
      // Echo back the token subprotocol a browser client proposed, so its
      // handshake completes; otherwise negotiate no subprotocol.
      handleProtocols: (_protocols, request) => tokenSubprotocol(request) ?? false,
    });
    this.#http.on('upgrade', (req, socket, head) => this.#onUpgrade(req, socket, head));
  }

  /** Start listening; resolves with the bound address. */
  listen(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#http.once('error', onError);
      this.#http.listen(this.#port, this.#host, () => {
        this.#http.off('error', onError);
        const address = this.#http.address();
        const port = typeof address === 'object' && address !== null ? address.port : this.#port;
        this.#log({ level: 'info', msg: 'shim listening', data: { host: this.#host, port } });
        resolve({ host: this.#host, port });
      });
    });
  }

  /** Number of currently open client connections. */
  get connectionCount(): number {
    return this.#connections.size;
  }

  /** Stop accepting connections and close the ones open. */
  close(): Promise<void> {
    for (const ws of this.#connections) ws.close(1001, 'shim shutting down');
    return new Promise((resolve) => {
      this.#wss.close(() => this.#http.close(() => resolve()));
    });
  }

  #onUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const auth = authenticate(request, this.#token);
    if (!auth.ok) {
      const status = auth.reason === 'missing' ? 401 : 403;
      this.#log({ level: 'warn', msg: 'rejected upgrade', data: { reason: auth.reason } });
      socket.write(`HTTP/1.1 ${status} ${auth.reason}\r\nconnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    this.#wss.handleUpgrade(request, socket, head, (ws) => this.#onConnection(ws));
  }

  #onConnection(ws: WebSocket): void {
    this.#connections.add(ws);
    const peer = new JsonRpcPeer((message) => {
      if (ws.readyState === ws.OPEN) ws.send(message);
    });
    const connection = this.#connect(peer);
    this.#log({ level: 'info', msg: 'client connected', data: { total: this.#connections.size } });

    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      void peer.receive(bufferToString(data));
    });
    const teardown = (): void => {
      if (!this.#connections.delete(ws)) return;
      connection.close();
      peer.close('client disconnected');
      this.#log({
        level: 'info',
        msg: 'client disconnected',
        data: { total: this.#connections.size },
      });
    };
    ws.on('close', teardown);
    ws.on('error', teardown);
  }
}

/** Normalize a `ws` message payload to a UTF-8 string. */
function bufferToString(data: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
