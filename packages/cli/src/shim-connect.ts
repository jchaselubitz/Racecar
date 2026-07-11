/**
 * Connecting a Racecar CLI to a sandbox's shim over its preview-URL WebSocket.
 *
 * `racecar chat` and the rewired `racecar run` are ACP clients of the in-sandbox
 * shim. Reaching it means clearing two independent gates: Daytona's preview proxy
 * (the `x-daytona-preview-token` the provider hands back with the URL) and the
 * shim's own per-sandbox token (`x-racecar-shim-token`). The shim token is
 * injected as a sandbox env var and never persisted host-side, so this module
 * reads it back over the exec channel and registers it for output redaction before
 * it can leak. The result is a ready {@link AcpClient} plus a `closed` promise that
 * settles when the socket ends, so a command can await disconnect.
 */
import { WebSocket, type RawData } from 'ws';
import {
  AcpClient,
  JsonRpcPeer,
  SHIM_DEFAULT_PORT,
  SHIM_TOKEN_HEADER,
  type AcpClientHandlers,
  type ClientCapabilities,
} from '@racecar/shim';
import { Redactor, shimTokenScript, type SandboxProvider } from '@racecar/core';
import { installOutputRedaction } from './credentials.js';

/** Daytona's preview-proxy auth header for a private sandbox's preview URL. */
const DAYTONA_PREVIEW_TOKEN_HEADER = 'x-daytona-preview-token';

/** A live shim connection: the ACP client and the socket lifetime around it. */
export interface ShimConnection {
  readonly client: AcpClient;
  /** Resolves when the socket closes cleanly; rejects on a socket error. */
  readonly closed: Promise<void>;
  /** Close the socket (ends the connection; the shim keeps owning the run). */
  readonly close: () => void;
}

/** Options for {@link connectShim}. */
export interface ConnectShimOptions {
  readonly handlers?: AcpClientHandlers;
  readonly clientCapabilities?: ClientCapabilities;
  /** Skip the exec token read by supplying the shim token directly (tests). */
  readonly token?: string;
  /** Skip provider preview resolution by supplying the ws URL directly (tests). */
  readonly url?: string;
}

/** Turn a preview `http(s)://…` origin into its `ws(s)://…` equivalent. */
export function toWebSocketUrl(previewUrl: string): string {
  if (previewUrl.startsWith('https://')) return `wss://${previewUrl.slice('https://'.length)}`;
  if (previewUrl.startsWith('http://')) return `ws://${previewUrl.slice('http://'.length)}`;
  return previewUrl;
}

/** Read the sandbox's shim token over exec and register it for redaction. */
async function readShimToken(provider: SandboxProvider, sandboxId: string): Promise<string> {
  const result = await provider.exec(sandboxId, { command: shimTokenScript(), timeoutSeconds: 15 });
  const token = result.output.trim();
  if (token.length === 0) {
    throw new Error(
      `sandbox '${sandboxId}' has no shim token; is the shim running? (racecar sandbox create starts it)`,
    );
  }
  // Scrub the token from any subsequent output before it can be echoed.
  installOutputRedaction(new Redactor([token]));
  return token;
}

/**
 * Open an authenticated ACP connection to a sandbox's shim. Resolves once the
 * WebSocket is open and an {@link AcpClient} is wired over it; the caller then
 * `initialize`s and drives sessions.
 */
export async function connectShim(
  provider: SandboxProvider,
  sandboxId: string,
  options: ConnectShimOptions = {},
): Promise<ShimConnection> {
  const token = options.token ?? (await readShimToken(provider, sandboxId));
  let wsUrl = options.url;
  const headers: Record<string, string> = { [SHIM_TOKEN_HEADER]: token };
  if (wsUrl === undefined) {
    const preview = await provider.getPreviewUrl(sandboxId, SHIM_DEFAULT_PORT);
    wsUrl = toWebSocketUrl(preview.url);
    if (preview.token !== undefined) headers[DAYTONA_PREVIEW_TOKEN_HEADER] = preview.token;
  }

  const ws = new WebSocket(wsUrl, { headers });
  const peer = new JsonRpcPeer((message) => {
    if (ws.readyState === ws.OPEN) ws.send(message);
  });
  ws.on('message', (data: RawData) => void peer.receive(rawToString(data)));
  const client = new AcpClient(peer, {
    ...(options.handlers !== undefined ? { handlers: options.handlers } : {}),
    ...(options.clientCapabilities !== undefined
      ? { clientCapabilities: options.clientCapabilities }
      : {}),
  });

  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('unexpected-response', (_req, res) =>
      reject(new Error(`shim rejected the connection: HTTP ${res.statusCode}`)),
    );
    ws.once('error', (err) => reject(err));
  });

  const closed = new Promise<void>((resolve, reject) => {
    ws.on('close', () => {
      peer.close('shim connection closed');
      resolve();
    });
    ws.on('error', (err) => {
      peer.close('shim connection error');
      reject(err);
    });
  });
  // The caller owns closed; a background rejection must not crash the process.
  closed.catch(() => {});

  return {
    client,
    closed,
    close: () => ws.close(),
  };
}

/** Normalize a `ws` payload to a UTF-8 string. */
function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}
