import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  ACP_PROTOCOL_VERSION,
  AcpMethod,
  type InitializeResponse,
  type NewSessionResponse,
  type PromptResponse,
  type SessionUpdateNotification,
} from './acp.js';
import { AcpAgentServer } from './acp-server.js';
import { ProcessAcpAgent } from './acp-client.js';
import { EchoAgent, type Agent, type AgentSession, type SessionClient } from './agent.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { spawnAgentProcess, type AgentProcess } from './stdio.js';

/**
 * An in-memory {@link AgentProcess} whose stdin/stdout are wired to a southbound
 * mock ACP agent, so a {@link ProcessAcpAgent} can be exercised with no subprocess.
 * `kill` reports an exit so exit handling is testable too.
 */
function fakeAcpProcess(agent: Agent): AgentProcess {
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((info: { code: number | null; signal: null }) => void)[] = [];
  const serverPeer = new JsonRpcPeer((m) => {
    for (const handler of lineHandlers) handler(m);
  });
  new AcpAgentServer(serverPeer, agent);
  return {
    writeLine: (line) => void serverPeer.receive(line),
    onLine: (handler) => lineHandlers.push(handler),
    onStderr: () => {},
    onExit: (handler) => exitHandlers.push(handler),
    kill: () => {
      for (const handler of exitHandlers) handler({ code: 0, signal: null });
    },
  };
}

/** Wire a client JSON-RPC peer to an {@link AcpAgentServer} bound to `agent`. */
function connect(agent: Agent): JsonRpcPeer {
  const peers: { client?: JsonRpcPeer; server?: JsonRpcPeer } = {};
  peers.client = new JsonRpcPeer((m) => void peers.server!.receive(m));
  peers.server = new JsonRpcPeer((m) => void peers.client!.receive(m));
  new AcpAgentServer(peers.server, agent);
  return peers.client;
}

describe('ProcessAcpAgent over an in-memory ACP subprocess', () => {
  it('surfaces the subprocess capabilities northbound unchanged', async () => {
    const southbound: Agent = {
      capabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
      },
      newSession: (client) => new EchoAgent().newSession(client),
    };
    const client = connect(new ProcessAcpAgent(fakeAcpProcess(southbound)));
    const init = await client.request<InitializeResponse>(AcpMethod.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
    });
    expect(init.agentCapabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
    });
  });

  it('proxies a full session: new, prompt, streamed update, end_turn', async () => {
    const client = connect(new ProcessAcpAgent(fakeAcpProcess(new EchoAgent())));
    await client.request(AcpMethod.initialize, { protocolVersion: ACP_PROTOCOL_VERSION });
    const updates: SessionUpdateNotification[] = [];
    client.onNotification(
      AcpMethod.update,
      (p) => void updates.push(p as SessionUpdateNotification),
    );
    const { sessionId } = await client.request<NewSessionResponse>(AcpMethod.newSession, {});
    const result = await client.request<PromptResponse>(AcpMethod.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'echo: hello' },
      },
    });
  });

  it('routes a permission request from the subprocess to the northbound client', async () => {
    // A southbound agent that asks its client (the shim) for permission mid-turn.
    const southbound: Agent = {
      capabilities: {},
      newSession(client): AgentSession {
        return {
          id: 'perm-1',
          async prompt(): Promise<PromptResponse> {
            const response = await client.requestPermission({
              toolCall: { toolCallId: 'tc1', title: 'write file' },
              options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }],
            });
            return {
              stopReason: response.outcome.outcome === 'selected' ? 'end_turn' : 'cancelled',
            };
          },
          cancel() {},
          close() {},
        };
      },
    };
    const client = connect(new ProcessAcpAgent(fakeAcpProcess(southbound)));
    const permission = vi.fn(() => ({ outcome: { outcome: 'selected', optionId: 'ok' } }));
    client.onRequest(AcpMethod.requestPermission, permission);
    const { sessionId } = await client.request<NewSessionResponse>(AcpMethod.newSession, {});
    const result = await client.request<PromptResponse>(AcpMethod.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'go' }],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(permission).toHaveBeenCalledOnce();
  });

  it('injects a mid-run message as a session/prompt on the subprocess, only during a turn', async () => {
    // A southbound agent that counts prompt turns and never resolves them, so a
    // turn stays in flight while we inject a second message on the same session.
    let prompts = 0;
    const proc = fakeAcpProcess({
      capabilities: {},
      newSession: () => ({
        id: 'inj-1',
        prompt: () => {
          prompts += 1;
          return new Promise<PromptResponse>(() => {});
        },
        cancel() {},
        close() {},
      }),
    });
    const agent = new ProcessAcpAgent(proc);
    const session = await agent.newSession(
      { sessionUpdate() {}, requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }) },
      {},
    );

    // No turn in flight: injection is refused so the shim queues instead.
    expect(session.inject?.([{ type: 'text', text: 'early' }])).toBe(false);
    await Promise.resolve();
    expect(prompts).toBe(0);

    void session.prompt([{ type: 'text', text: 'go' }]);
    await vi.waitFor(() => expect(prompts).toBe(1));
    expect(session.inject?.([{ type: 'text', text: 'also this' }])).toBe(true);
    await vi.waitFor(() => expect(prompts).toBe(2));
  });

  it('rejects an in-flight prompt when the subprocess dies', async () => {
    // A southbound agent whose prompt never resolves, so only the exit ends it.
    const proc = fakeAcpProcess({
      capabilities: {},
      newSession: () => ({
        id: 'hang-1',
        prompt: () => new Promise<PromptResponse>(() => {}),
        cancel() {},
        close() {},
      }),
    });
    const agent = new ProcessAcpAgent(proc);
    const session = await agent.newSession(
      { sessionUpdate() {}, requestPermission: () => Promise.reject(new Error('n/a')) },
      {},
    );
    const pending = session.prompt([{ type: 'text', text: 'hi' }]);
    proc.kill(); // Simulate the subprocess exiting.
    await expect(pending).rejects.toThrow(/agent process exited/);
  });
});

describe('ProcessAcpAgent over a real subprocess', () => {
  const fixture = fileURLToPath(new URL('../test-fixtures/acp-agent.mjs', import.meta.url));

  it('drives a spawned ACP agent end-to-end over stdio', async () => {
    const agent = new ProcessAcpAgent(
      spawnAgentProcess({ command: process.execPath, args: [fixture] }),
    );
    await agent.ready();
    expect(agent.capabilities).toEqual({
      loadSession: true,
      promptCapabilities: { image: true, audio: false, embeddedContext: true },
    });
    const updates: Parameters<SessionClient['sessionUpdate']>[0][] = [];
    const client: SessionClient = {
      sessionUpdate: (u) => updates.push(u),
      requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    };
    const session = await agent.newSession(client, {});
    expect(session.id).toBe('srv-session-1');
    const result = await session.prompt([{ type: 'text', text: 'hi' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'pong: hi' },
    });
    agent.close();
  });
});
