import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, type RawData } from 'ws';
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type RequestPermissionResponse,
  type SessionUpdateNotification,
} from './acp.js';
import { ProcessAcpAgent } from './acp-client.js';
import { EchoAgent, type AgentFactory } from './agent.js';
import { AcpClient } from './client.js';
import { SHIM_TOKEN_HEADER } from './contract.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { RunAgentServer } from './run-server.js';
import { RunRegistry } from './runs.js';
import { ShimServer, type ConnectionHandler } from './server.js';
import { spawnAgentProcess } from './stdio.js';

const TOKEN = 'test-sandbox-token';

/** Poll `predicate` until true or a short deadline, for cross-socket delivery. */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

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
async function startServer(
  agentFactory?: AgentFactory,
): Promise<{ server: ShimServer; url: string }> {
  const server = new ShimServer({
    token: TOKEN,
    port: 0,
    host: '127.0.0.1',
    ...(agentFactory ? { agentFactory } : {}),
  });
  servers.push(server);
  const { port } = await server.listen();
  return { server, url: `ws://127.0.0.1:${port}` };
}

/** Start a shim server whose connections share one registry (the daemon wiring). */
async function startRunServer(connect: ConnectionHandler): Promise<{ url: string }> {
  const server = new ShimServer({ token: TOKEN, port: 0, host: '127.0.0.1', connect });
  servers.push(server);
  const { port } = await server.listen();
  return { url: `ws://127.0.0.1:${port}` };
}

/** Open a ws client wrapped in an {@link AcpClient} (resolves once open). */
function openAcpClient(
  url: string,
  handlers?: ConstructorParameters<typeof AcpClient>[1],
): Promise<AcpClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { [SHIM_TOKEN_HEADER]: TOKEN } });
    sockets.push(ws);
    const peer = new JsonRpcPeer((m) => ws.send(m));
    ws.on('message', (data: RawData) => void peer.receive(rawToString(data)));
    ws.on('open', () => resolve(new AcpClient(peer, handlers)));
    ws.on('error', (err) => reject(err));
  });
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

describe('ShimServer with a shared run registry over the WebSocket', () => {
  // The daemon wiring: connections share one RunRegistry, so a run created by one
  // client is discoverable and joinable by another — chat and run on one run.
  const withRegistry = (): ConnectionHandler => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    return (peer) => new RunAgentServer(peer, registry);
  };

  it('lets two WebSocket clients supervise the same run simultaneously', async () => {
    const { url } = await startRunServer(withRegistry());
    const aUpdates: SessionUpdateNotification[] = [];
    const a = await openAcpClient(url, { handlers: { onUpdate: (u) => aUpdates.push(u) } });
    await a.initialize();
    const runId = await a.newSession();

    const bUpdates: SessionUpdateNotification[] = [];
    const b = await openAcpClient(url, { handlers: { onUpdate: (u) => bUpdates.push(u) } });
    await b.initialize();
    expect((await b.listSessions()).map((s) => s.sessionId)).toContain(runId);
    await b.attachSession(runId);

    // A prompt driven by A streams to both A and B. B's update arrives over its
    // own socket, so wait for it rather than assuming same-tick delivery.
    await a.prompt(runId, [{ type: 'text', text: 'shared' }]);
    await waitFor(() => bUpdates.length >= 1);
    expect(aUpdates.at(-1)).toMatchObject({ update: { content: { text: 'echo: shared' } } });
    expect(bUpdates.at(-1)).toMatchObject({ update: { content: { text: 'echo: shared' } } });
  });
});

describe('ShimServer permission flow over the WebSocket', () => {
  // A real ACP subprocess that requests permission mid-turn; the shim forwards it
  // northbound and the client answers — the exact path `racecar chat` drives.
  const fixture = fileURLToPath(
    new URL('../test-fixtures/acp-permission-agent.mjs', import.meta.url),
  );
  const connect: ConnectionHandler = (() => {
    const registry = new RunRegistry({
      agent: new ProcessAcpAgent(spawnAgentProcess({ command: process.execPath, args: [fixture] })),
    });
    return (peer) => new RunAgentServer(peer, registry);
  })();

  it('prompts the client for permission and applies the choice', async () => {
    const { url } = await startRunServer(connect);
    const updates: SessionUpdateNotification[] = [];
    let asked: RequestPermissionResponse | undefined;
    const client = await openAcpClient(url, {
      handlers: {
        onUpdate: (u) => updates.push(u),
        onPermission: (request) => {
          const choice = request.options.find((o) => o.kind === 'allow_once');
          const outcome: RequestPermissionResponse = {
            outcome: { outcome: 'selected', optionId: choice?.optionId ?? 'reject' },
          };
          asked = outcome;
          return outcome;
        },
      },
    });
    await client.initialize();
    const runId = await client.newSession();
    const result = await client.prompt(runId, [{ type: 'text', text: 'rm -rf' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(asked).toBeDefined();
    expect(updates.at(-1)).toMatchObject({ update: { content: { text: 'decision: allow' } } });
  });
});

describe('ShimServer driving a tier-1 ACP subprocess over the WebSocket', () => {
  // The full exit-criteria path: a WebSocket ACP client → ShimServer → the tier-1
  // ProcessAcpAgent adapter → a real ACP agent subprocess, capabilities and all.
  const fixture = fileURLToPath(new URL('../test-fixtures/acp-agent.mjs', import.meta.url));
  const factory: AgentFactory = () =>
    new ProcessAcpAgent(spawnAgentProcess({ command: process.execPath, args: [fixture] }));

  it('initializes with the subprocess capabilities and holds a session', async () => {
    const { url } = await startServer(factory);
    const { peer } = await openClient(url, { headers: { [SHIM_TOKEN_HEADER]: TOKEN } });
    const init = await peer.request<InitializeResponse>(AcpMethod.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
    });
    expect(init.agentCapabilities).toMatchObject({ loadSession: true });
    const updates: SessionUpdateNotification[] = [];
    peer.onNotification(AcpMethod.update, (p) => void updates.push(p as SessionUpdateNotification));
    const { sessionId } = await peer.request<NewSessionResponse>(AcpMethod.newSession, {});
    const result = await peer.request<PromptResponse>(AcpMethod.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'ping' }],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(updates.find((u) => u.sessionId === sessionId)?.update).toMatchObject({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'pong: ping' },
    });
  });
});
