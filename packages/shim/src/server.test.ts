import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type SessionUpdateNotification,
} from './acp.js';
import { SHIM_TOKEN_HEADER } from './contract.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { ShimServer } from './server.js';

const TOKEN = 'test-sandbox-token';

/** Normalize a `ws` message payload to a UTF-8 string. */
function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  return data.toString('utf8');
}

let servers: ShimServer[] = [];
let sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets) ws.close();
  sockets = [];
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/** Start a shim server on an ephemeral port and return its URL. */
async function startServer(): Promise<{ server: ShimServer; url: string }> {
  const server = new ShimServer({ token: TOKEN, port: 0, host: '127.0.0.1' });
  servers.push(server);
  const { port } = await server.listen();
  return { server, url: `ws://127.0.0.1:${port}` };
}

/** Open a ws client and wrap it in a JSON-RPC peer; resolves once open. */
function openClient(
  url: string,
  options: ConstructorParameters<typeof WebSocket>[2] = {},
): Promise<{ ws: WebSocket; peer: JsonRpcPeer }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    sockets.push(ws);
    const peer = new JsonRpcPeer((m) => ws.send(m));
    ws.on('message', (data: RawData) => void peer.receive(rawToString(data)));
    ws.on('open', () => resolve({ ws, peer }));
    ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
    ws.on('error', (err) => reject(err));
  });
}

describe('ShimServer authentication', () => {
  it('rejects an upgrade with no token (401)', async () => {
    const { url } = await startServer();
    await expect(openClient(url)).rejects.toThrow('HTTP 401');
  });

  it('rejects an upgrade with a wrong token (403)', async () => {
    const { url } = await startServer();
    await expect(openClient(url, { headers: { [SHIM_TOKEN_HEADER]: 'wrong' } })).rejects.toThrow(
      'HTTP 403',
    );
  });

  it('accepts an upgrade with the header token', async () => {
    const { url } = await startServer();
    const { peer } = await openClient(url, { headers: { [SHIM_TOKEN_HEADER]: TOKEN } });
    const init = await peer.request<InitializeResponse>(AcpMethod.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
    });
    expect(init.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  });

  it('accepts an upgrade with the query-param token', async () => {
    const { url } = await startServer();
    const { peer } = await openClient(`${url}/?racecar_token=${TOKEN}`);
    const init = await peer.request<InitializeResponse>(AcpMethod.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
    });
    expect(init.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  });
});

describe('ShimServer ACP session over a real WebSocket', () => {
  it('holds a full session end-to-end', async () => {
    const { url } = await startServer();
    const { peer } = await openClient(url, { headers: { [SHIM_TOKEN_HEADER]: TOKEN } });
    await peer.request(AcpMethod.initialize, { protocolVersion: ACP_PROTOCOL_VERSION });
    const updates: SessionUpdateNotification[] = [];
    peer.onNotification(AcpMethod.update, (p) => void updates.push(p as SessionUpdateNotification));
    const { sessionId } = await peer.request<NewSessionResponse>(AcpMethod.newSession, {});
    const result = await peer.request<PromptResponse>(AcpMethod.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'ping' }],
    });
    expect(result.stopReason).toBe('end_turn');
    const chunk = updates.find((u) => u.sessionId === sessionId);
    expect(chunk?.update.sessionUpdate).toBe('agent_message_chunk');
  });

  it('serves two concurrent clients with independent sessions', async () => {
    const { server, url } = await startServer();
    const a = await openClient(url, { headers: { [SHIM_TOKEN_HEADER]: TOKEN } });
    const b = await openClient(url, { headers: { [SHIM_TOKEN_HEADER]: TOKEN } });
    const sa = await a.peer.request<NewSessionResponse>(AcpMethod.newSession, {});
    const sb = await b.peer.request<NewSessionResponse>(AcpMethod.newSession, {});
    expect(sa.sessionId).not.toBe(sb.sessionId);
    expect(server.connectionCount).toBe(2);
  });
});
