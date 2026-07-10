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
import { EchoAgent, type Agent, type AgentSession, type SessionClient } from './agent.js';
import { JsonRpcPeer } from './jsonrpc.js';

/** A client peer wired to an {@link AcpAgentServer} over an in-memory link. */
function connect(agent: Agent): { client: JsonRpcPeer; server: AcpAgentServer } {
  const peers: { client?: JsonRpcPeer; serverPeer?: JsonRpcPeer } = {};
  peers.client = new JsonRpcPeer((m) => void peers.serverPeer!.receive(m));
  peers.serverPeer = new JsonRpcPeer((m) => void peers.client!.receive(m));
  const server = new AcpAgentServer(peers.serverPeer, agent);
  return { client: peers.client, server };
}

describe('AcpAgentServer with EchoAgent', () => {
  it('initializes with the protocol version and agent capabilities', async () => {
    const { client } = connect(new EchoAgent());
    const init = await client.request<InitializeResponse>(AcpMethod.initialize, {
      protocolVersion: ACP_PROTOCOL_VERSION,
    });
    expect(init.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
    expect(init.agentCapabilities).toBeDefined();
    expect(init.authMethods).toEqual([]);
  });

  it('runs a full session: new, prompt, streamed update, end_turn', async () => {
    const { client } = connect(new EchoAgent());
    const updates: SessionUpdateNotification[] = [];
    client.onNotification(AcpMethod.update, (params) => {
      updates.push(params as SessionUpdateNotification);
    });
    const { sessionId } = await client.request<NewSessionResponse>(AcpMethod.newSession, {});
    expect(sessionId).toMatch(/^sess-/);
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

  it('rejects a prompt for an unknown session', async () => {
    const { client } = connect(new EchoAgent());
    await expect(
      client.request(AcpMethod.prompt, { sessionId: 'ghost', prompt: [] }),
    ).rejects.toThrow(/unknown session/);
  });
});

describe('AcpAgentServer permission requests', () => {
  it('forwards a permission request to the client and returns its choice', async () => {
    // An agent that asks for permission during its prompt turn.
    const permission = vi.fn(async (client: SessionClient) => {
      const response = await client.requestPermission({
        toolCall: { toolCallId: 'tc1', title: 'write file' },
        options: [
          { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
        ],
      });
      return response;
    });
    const agent: Agent = {
      capabilities: {},
      newSession(client) {
        const session: AgentSession = {
          id: 'sess-perm',
          async prompt() {
            const outcome = await permission(client);
            return {
              stopReason: outcome.outcome.outcome === 'selected' ? 'end_turn' : 'cancelled',
            };
          },
          cancel() {},
          close() {},
        };
        return session;
      },
    };
    const { client } = connect(agent);
    client.onRequest(AcpMethod.requestPermission, () => ({
      outcome: { outcome: 'selected', optionId: 'ok' },
    }));
    const { sessionId } = await client.request<NewSessionResponse>(AcpMethod.newSession, {});
    const result = await client.request<PromptResponse>(AcpMethod.prompt, {
      sessionId,
      prompt: [{ type: 'text', text: 'do it' }],
    });
    expect(result.stopReason).toBe('end_turn');
    expect(permission).toHaveBeenCalledOnce();
  });
});
