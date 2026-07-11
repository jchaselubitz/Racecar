import { describe, expect, it } from 'vitest';
import type {
  MailboxUpdateNotification,
  RequestPermissionRequest,
  SessionUpdateNotification,
} from './acp.js';
import { EchoAgent } from './agent.js';
import { AcpClient } from './client.js';
import { JsonRpcPeer } from './jsonrpc.js';
import { Mailbox } from './mailbox.js';
import { RunAgentServer } from './run-server.js';
import { RunRegistry } from './runs.js';

/**
 * Link two JSON-RPC peers over an in-memory async transport, so a client peer and
 * a server peer exchange messages exactly as they would over a socket, minus the
 * socket. `queueMicrotask` keeps it async (no reentrant recursion).
 */
function linkedPeers(): { client: JsonRpcPeer; server: JsonRpcPeer } {
  const peers: { client?: JsonRpcPeer; server?: JsonRpcPeer } = {};
  const client = new JsonRpcPeer((m) => queueMicrotask(() => void peers.server?.receive(m)));
  const server = new JsonRpcPeer((m) => queueMicrotask(() => void peers.client?.receive(m)));
  peers.client = client;
  peers.server = server;
  return { client, server };
}

/** Wire a fresh connection (client + server peer) onto one shared registry. */
function connect(
  registry: RunRegistry,
  handlers?: ConstructorParameters<typeof AcpClient>[1],
  mailbox?: Mailbox,
): { client: AcpClient; server: RunAgentServer } {
  const { client: clientPeer, server: serverPeer } = linkedPeers();
  const server = new RunAgentServer(serverPeer, registry, mailbox);
  const client = new AcpClient(clientPeer, handlers);
  return { client, server };
}

describe('RunAgentServer over the ACP client', () => {
  it('initializes, creates a run, and streams a prompt turn', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const updates: SessionUpdateNotification[] = [];
    const { client } = connect(registry, { handlers: { onUpdate: (u) => updates.push(u) } });

    const init = await client.initialize();
    expect(init.protocolVersion).toBe(1);
    const sessionId = await client.newSession();
    const result = await client.prompt(sessionId, [{ type: 'text', text: 'ping' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { text: 'echo: ping' } },
    });
  });

  it('lets a second connection list and attach to a run started by the first', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const a = connect(registry);
    await a.client.initialize();
    const runId = await a.client.newSession();
    await a.client.prompt(runId, [{ type: 'text', text: 'from a' }]);

    // A second client discovers the run and attaches — it should see the replay.
    const bUpdates: SessionUpdateNotification[] = [];
    const b = connect(registry, { handlers: { onUpdate: (u) => bUpdates.push(u) } });
    await b.client.initialize();
    const listed = await b.client.listSessions();
    expect(listed.map((s) => s.sessionId)).toContain(runId);

    const summary = await b.client.attachSession(runId);
    expect(summary.sessionId).toBe(runId);
    // The prior turn is replayed on attach.
    expect(bUpdates).toHaveLength(1);
    expect(bUpdates[0]).toMatchObject({ update: { content: { text: 'echo: from a' } } });

    // A new turn (driven by A) is now seen live by B too: one run, two supervisors.
    await a.client.prompt(runId, [{ type: 'text', text: 'again' }]);
    expect(bUpdates).toHaveLength(2);
    expect(bUpdates[1]).toMatchObject({ update: { content: { text: 'echo: again' } } });
  });

  it('routes a permission request to the connection that prompted', async () => {
    // An agent that asks permission mid-turn (see runs.test.ts PermissionAgent).
    const registry = new RunRegistry({
      agent: {
        capabilities: {},
        newSession: (client) => ({
          id: 's',
          prompt: async () => {
            const answer = await client.requestPermission({
              toolCall: { toolCallId: 'c1', title: 'danger' },
              options: [{ optionId: 'ok', name: 'OK', kind: 'allow_once' }],
            });
            client.sessionUpdate({
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: answer.outcome.outcome === 'selected' ? answer.outcome.optionId : 'no',
              },
            });
            return { stopReason: 'end_turn' };
          },
          cancel: () => {},
          close: () => {},
        }),
      },
    });

    const seen: RequestPermissionRequest[] = [];
    const { client } = connect(registry, {
      handlers: {
        onUpdate: () => {},
        onPermission: (request) => {
          seen.push(request);
          return { outcome: { outcome: 'selected', optionId: 'ok' } };
        },
      },
    });
    await client.initialize();
    const runId = await client.newSession();
    await client.prompt(runId, [{ type: 'text', text: 'go' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sessionId).toBe(runId);
    expect(seen[0]?.toolCall.title).toBe('danger');
  });
});

describe('mailbox over the ACP client', () => {
  it('lists, posts, and marks read against the shared mailbox', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const mailbox = new Mailbox();
    const { client } = connect(registry, undefined, mailbox);
    await client.initialize();

    // The agent side posted a question before this client ever connected.
    const question = mailbox.post({ kind: 'question', text: 'ship it?', sessionId: 'run-1' });
    expect(await client.mailboxList()).toHaveLength(1);

    const reply = await client.mailboxPost({ text: 'ship it', inReplyTo: question.id });
    expect(reply.kind).toBe('reply');
    expect(mailbox.get(question.id)?.awaitingReply).toBe(false);

    const changed = await client.mailboxMarkRead([question.id]);
    expect(changed).toHaveLength(1);
    expect(await client.mailboxList({ unreadOnly: true })).toHaveLength(1); // only the reply
  });

  it('pushes a mailbox update to every connected client live', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const mailbox = new Mailbox();
    const seenA: MailboxUpdateNotification[] = [];
    const seenB: MailboxUpdateNotification[] = [];
    const a = connect(registry, { handlers: { onMailboxUpdate: (n) => seenA.push(n) } }, mailbox);
    const b = connect(registry, { handlers: { onMailboxUpdate: (n) => seenB.push(n) } }, mailbox);
    await a.client.initialize();
    await b.client.initialize();

    // A posts an instruction; both A and B are notified (fan-in supervision).
    await a.client.mailboxPost({ text: 'run the suite' });
    await Promise.resolve(); // let the queued notifications drain
    expect(seenA.at(-1)?.message.text).toBe('run the suite');
    expect(seenB.at(-1)?.message.text).toBe('run the suite');

    // The agent posting a completion also reaches both live.
    mailbox.post({ kind: 'completion', text: 'done' });
    await Promise.resolve();
    expect(seenA.at(-1)?.message.kind).toBe('completion');
    expect(seenB.at(-1)?.message.kind).toBe('completion');
  });

  it('rejects mailbox methods when the shim has no mailbox', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const { client } = connect(registry); // no mailbox
    await client.initialize();
    await expect(client.mailboxList()).rejects.toThrow();
  });
});
