import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EchoAgent,
  Mailbox,
  MailboxDelivery,
  RunAgentServer,
  RunRegistry,
  ShimServer,
  type Agent,
  type AgentSession,
  type MailboxMessage,
  type PromptResponse,
  type SessionClient,
} from '@racecar/shim';
import { FakeSandboxProvider, type FakeExecHandler } from '@racecar/core/testing';
import { encodeSandboxLabels, type PreviewUrl } from '@racecar/core';
import {
  collectInbox,
  formatInbox,
  formatMailboxMessage,
  replyToMessage,
  sendInstruction,
} from './msg.js';

const TOKEN = 'msg-test-token';

const tokenExec: FakeExecHandler = (_id, request) =>
  request.command.includes('RACECAR_SHIM_TOKEN')
    ? { exitCode: 0, output: TOKEN }
    : { exitCode: 0, output: '' };

/** A no-op agent: the mailbox tests never drive a turn, only mailbox traffic. */
const idleAgent: Agent = {
  capabilities: {},
  newSession: () => ({
    id: 'idle',
    prompt: () => Promise.resolve({ stopReason: 'end_turn' as const }),
    cancel: () => {},
    close: () => {},
  }),
};

/**
 * A provider that routes each sandbox to its own shim server (and hence its own
 * mailbox), so `collectInbox` can be exercised across several sandboxes at once.
 */
class MultiShimProvider extends FakeSandboxProvider {
  readonly #urls = new Map<string, string>();
  constructor() {
    super({ execHandler: tokenExec });
  }
  register(id: string, url: string): void {
    this.#urls.set(id, url);
  }
  override getPreviewUrl(id: string): Promise<PreviewUrl> {
    const url = this.#urls.get(id);
    if (url === undefined) throw new Error(`no shim url registered for ${id}`);
    return Promise.resolve({ url });
  }
}

interface Fixture {
  readonly provider: MultiShimProvider;
  readonly mailboxes: Map<string, Mailbox>;
}

let servers: ShimServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/** Stand up N mailbox-backed shims and a managed sandbox in front of each. */
async function fixture(missions: readonly string[]): Promise<Fixture> {
  const provider = new MultiShimProvider();
  await provider.buildSnapshot({ name: 'snap', baseImage: 'node:24' });
  const mailboxes = new Map<string, Mailbox>();
  for (const mission of missions) {
    const mailbox = new Mailbox();
    const registry = new RunRegistry({ agent: idleAgent });
    const server = new ShimServer({
      token: TOKEN,
      port: 0,
      host: '127.0.0.1',
      connect: (peer) => new RunAgentServer(peer, registry, mailbox),
    });
    servers.push(server);
    const { port } = await server.listen();
    const id = (
      await provider.createSandbox({
        snapshot: 'snap',
        name: `sbx-${mission}`,
        labels: encodeSandboxLabels({
          project: 'proj',
          mission,
          branch: 'main',
          snapshot: 'snap',
          createdAt: new Date().toISOString(),
          role: 'mission',
        }),
      })
    ).id;
    provider.register(id, `http://127.0.0.1:${port}`);
    mailboxes.set(id, mailbox);
  }
  return { provider, mailboxes };
}

describe('formatMailboxMessage', () => {
  it('marks unread and awaiting-reply, and indents the body', () => {
    const message: MailboxMessage = {
      id: 'msg-1',
      kind: 'question',
      direction: 'agent_to_user',
      text: 'delete the build dir?',
      createdAt: '2026-07-11T10:00:00.000Z',
      read: false,
      awaitingReply: true,
    };
    const rendered = formatMailboxMessage(message);
    expect(rendered).toContain('●');
    expect(rendered).toContain('question');
    expect(rendered).toContain('(awaiting reply)');
    expect(rendered).toContain('        delete the build dir?');
  });

  it('drops the unread dot and awaiting note for a read completion', () => {
    const rendered = formatMailboxMessage({
      id: 'msg-2',
      kind: 'completion',
      direction: 'agent_to_user',
      text: 'done',
      createdAt: '2026-07-11T10:00:00.000Z',
      read: true,
    });
    expect(rendered).not.toContain('●');
    expect(rendered).not.toContain('awaiting reply');
  });
});

describe('formatInbox', () => {
  it('reports no managed sandboxes and an unavailable sandbox distinctly', () => {
    expect(formatInbox([])).toBe('no managed sandboxes\n');
    const sandbox = {
      id: 'sbx-1',
      project: 'proj',
      mission: 'm',
      branch: 'main',
      snapshot: 'snap',
      state: 'stopped' as const,
      createdAt: '2026-07-11T10:00:00.000Z',
      lastActivityAt: '2026-07-11T10:00:00.000Z',
      labels: {},
    };
    const rendered = formatInbox([
      { sandbox, messages: [], running: 0, error: 'sandbox is stopped' },
    ]);
    expect(rendered).toContain('sbx-1  proj/m  [stopped]');
    expect(rendered).toContain('(sandbox is stopped)');
  });

  it('annotates a silently-running sandbox with its run count', () => {
    const sandbox = {
      id: 'sbx-2',
      project: 'proj',
      mission: 'm',
      branch: 'main',
      snapshot: 'snap',
      state: 'started' as const,
      createdAt: '2026-07-11T10:00:00.000Z',
      lastActivityAt: '2026-07-11T10:00:00.000Z',
      labels: {},
    };
    const rendered = formatInbox([{ sandbox, messages: [], running: 1 }]);
    expect(rendered).toContain('(1 running)');
    expect(rendered).not.toContain('(no messages)');
  });
});

describe('sendInstruction', () => {
  it('posts a user→agent instruction into the sandbox mailbox', async () => {
    const { provider, mailboxes } = await fixture(['alpha']);
    const [id] = [...mailboxes.keys()];
    const message = await sendInstruction(provider, id!, 'please run the tests');
    expect(message.kind).toBe('instruction');
    expect(message.direction).toBe('user_to_agent');
    expect(
      mailboxes
        .get(id!)!
        .list()
        .map((m) => m.text),
    ).toContain('please run the tests');
  });
});

describe('replyToMessage', () => {
  it('clears the referenced question’s awaiting-reply flag', async () => {
    const { provider, mailboxes } = await fixture(['beta']);
    const [id] = [...mailboxes.keys()];
    const question = mailboxes.get(id!)!.post({ kind: 'question', text: 'proceed?' });
    expect(question.awaitingReply).toBe(true);

    const reply = await replyToMessage(provider, id!, question.id, 'yes, proceed');
    expect(reply.kind).toBe('reply');
    expect(reply.inReplyTo).toBe(question.id);
    expect(mailboxes.get(id!)!.get(question.id)!.awaitingReply).toBe(false);
  });
});

describe('collectInbox', () => {
  it('aggregates every started sandbox and marks stopped ones unavailable', async () => {
    const { provider, mailboxes } = await fixture(['done', 'asking', 'running']);
    const ids = [...mailboxes.keys()];
    const [doneId, askingId, runningId] = ids;

    // One completion, one question awaiting reply, one still-running (an update)
    // — exactly the three states the Stage 4 exit criteria describes.
    mailboxes.get(doneId!)!.post({ kind: 'completion', text: 'finished refactor' });
    mailboxes.get(askingId!)!.post({ kind: 'question', text: 'can I force-push?' });
    mailboxes.get(runningId!)!.post({ kind: 'update', text: 'still working…' });

    const inbox = await collectInbox(provider);
    expect(inbox).toHaveLength(3);
    const byId = new Map(inbox.map((box) => [box.sandbox.id, box]));
    expect(byId.get(doneId!)!.messages[0]!.kind).toBe('completion');
    expect(byId.get(askingId!)!.messages[0]!.awaitingReply).toBe(true);
    expect(byId.get(runningId!)!.messages[0]!.kind).toBe('update');

    // A stopped sandbox has no live shim: it is surfaced with an error, not dropped.
    await provider.stopSandbox(runningId!);
    const afterStop = await collectInbox(provider);
    const stopped = afterStop.find((box) => box.sandbox.id === runningId);
    expect(stopped!.error).toMatch(/stopped/);
    expect(stopped!.messages).toHaveLength(0);
  });

  it('restricts to a single sandbox and to unread messages', async () => {
    const { provider, mailboxes } = await fixture(['one', 'two']);
    const ids = [...mailboxes.keys()];
    const [oneId, twoId] = ids;
    const read = mailboxes.get(oneId!)!.post({ kind: 'completion', text: 'read one' });
    mailboxes.get(oneId!)!.markRead([read.id]);
    mailboxes.get(oneId!)!.post({ kind: 'update', text: 'unread one' });
    mailboxes.get(twoId!)!.post({ kind: 'update', text: 'two' });

    const single = await collectInbox(provider, { sandbox: oneId! });
    expect(single).toHaveLength(1);
    expect(single[0]!.sandbox.id).toBe(oneId);

    const unread = await collectInbox(provider, { sandbox: oneId!, unreadOnly: true });
    expect(unread[0]!.messages.map((m) => m.text)).toEqual(['unread one']);
  });
});

// --- full-stack exit criteria: queue → disconnect → inbox → reply → proceed ---

/** An agent whose turn blocks on a permission request, then reports the choice. */
class BlockingAgent implements Agent {
  readonly capabilities = {};
  newSession(client: SessionClient): AgentSession {
    return {
      id: 'block',
      prompt: async (): Promise<PromptResponse> => {
        const answer = await client.requestPermission({
          toolCall: { toolCallId: 't1', title: 'force-push to main' },
          options: [
            { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        client.sessionUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: answer.outcome.outcome === 'selected' ? `did ${answer.outcome.optionId}` : 'nope',
          },
        });
        return { stopReason: 'end_turn' };
      },
      cancel: () => {},
      close: () => {},
    };
  }
}

/** An agent whose turn never ends: the run stays running with nothing to post. */
class HangingAgent implements Agent {
  readonly capabilities = {};
  newSession(): AgentSession {
    return {
      id: 'hang',
      prompt: () => new Promise<PromptResponse>(() => {}),
      cancel: () => {},
      close: () => {},
    };
  }
}

/** Stand up a mailbox-backed, delivery-wired shim for each mission→agent pair. */
async function deliveryFixture(
  agents: Record<string, Agent>,
): Promise<{ provider: MultiShimProvider; ids: Record<string, string> }> {
  const provider = new MultiShimProvider();
  await provider.buildSnapshot({ name: 'snap', baseImage: 'node:24' });
  const ids: Record<string, string> = {};
  for (const [mission, agent] of Object.entries(agents)) {
    const mailbox = new Mailbox();
    const registry = new RunRegistry({ agent, mailbox });
    new MailboxDelivery(mailbox, registry);
    const server = new ShimServer({
      token: TOKEN,
      port: 0,
      host: '127.0.0.1',
      connect: (peer) => new RunAgentServer(peer, registry, mailbox),
    });
    servers.push(server);
    const { port } = await server.listen();
    const id = (
      await provider.createSandbox({
        snapshot: 'snap',
        name: `sbx-${mission}`,
        labels: encodeSandboxLabels({
          project: 'proj',
          mission,
          branch: 'main',
          snapshot: 'snap',
          createdAt: new Date().toISOString(),
          role: 'mission',
        }),
      })
    ).id;
    provider.register(id, `http://127.0.0.1:${port}`);
    ids[mission] = id;
  }
  return { provider, ids };
}

describe('Stage 4 exit criteria over the CLI', () => {
  it('queues to three sandboxes, then the inbox shows completion/question/running and a reply resumes the run', async () => {
    const { provider, ids } = await deliveryFixture({
      done: new EchoAgent(),
      asking: new BlockingAgent(),
      running: new HangingAgent(),
    });

    // Queue an instruction to each sandbox, then disconnect entirely — every call
    // opens and closes its own socket, so nothing holds a live connection.
    await sendInstruction(provider, ids.done!, 'summarize the changes');
    await sendInstruction(provider, ids.asking!, 'clean up the git history');
    await sendInstruction(provider, ids.running!, 'run the long migration');

    // Return later: the aggregated inbox shows all three states at once.
    let inbox = await collectInbox(provider);
    const box = (mission: string) => inbox.find((b) => b.sandbox.id === ids[mission])!;
    await vi.waitFor(async () => {
      inbox = await collectInbox(provider);
      expect(box('done').messages.some((m) => m.kind === 'completion')).toBe(true);
      expect(box('asking').messages.some((m) => m.kind === 'question' && m.awaitingReply)).toBe(
        true,
      );
    });
    expect(box('done').running).toBe(0);
    expect(box('running').running).toBe(1);
    expect(box('running').messages.some((m) => m.kind === 'completion')).toBe(false);

    // Reply to the awaiting question; the parked run proceeds to completion.
    const question = box('asking').messages.find((m) => m.kind === 'question')!;
    await replyToMessage(provider, ids.asking!, question.id, 'allow');

    await vi.waitFor(async () => {
      inbox = await collectInbox(provider);
      expect(box('asking').messages.some((m) => m.kind === 'completion')).toBe(true);
    });
    expect(box('asking').messages.find((m) => m.kind === 'question')!.awaitingReply).toBe(false);
    expect(box('asking').messages.find((m) => m.kind === 'completion')!.text).toBe('did ok');
  });
});
