import { describe, expect, it, vi } from 'vitest';
import { promptText, type PromptResponse, type RequestPermissionResponse } from './acp.js';
import { EchoAgent, type Agent, type AgentSession, type SessionClient } from './agent.js';
import { MailboxDelivery } from './delivery.js';
import { Mailbox } from './mailbox.js';
import { RunRegistry, type PermissionResponder } from './runs.js';

/** A responder that always selects `optionId` (an interactive turn owner). */
function allow(optionId: string): PermissionResponder {
  return {
    requestPermission: (): Promise<RequestPermissionResponse> =>
      Promise.resolve({ outcome: { outcome: 'selected', optionId } }),
  };
}

/**
 * An agent whose one session hangs each turn until `finish()` is called, records
 * the text of every prompt and every mid-run injection, and is injectable only
 * when `injectable` is set — so the tier-1/2 (inject) and tier-3 (queue) delivery
 * paths can both be driven deterministically.
 */
function controllableAgent(opts: { injectable?: boolean } = {}): {
  agent: Agent;
  prompts: string[];
  injected: string[];
  finish: (response?: PromptResponse) => void;
} {
  const prompts: string[] = [];
  const injected: string[] = [];
  let resolveTurn: ((response: PromptResponse) => void) | undefined;
  let client: SessionClient = {
    sessionUpdate: () => {},
    requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
  };
  const session: AgentSession = {
    id: 'ctl-1',
    prompt: (content) => {
      prompts.push(promptText(content));
      client.sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: promptText(content) },
      });
      return new Promise<PromptResponse>((resolve) => {
        resolveTurn = resolve;
      });
    },
    ...(opts.injectable === true
      ? {
          inject: (content): boolean => {
            injected.push(promptText(content));
            return true;
          },
        }
      : {}),
    cancel: () => {},
    close: () => {},
  };
  const agent: Agent = {
    capabilities: {},
    newSession: (c): AgentSession => {
      client = c;
      return session;
    },
  };
  return {
    agent,
    prompts,
    injected,
    finish: (response = { stopReason: 'end_turn' }): void => resolveTurn?.(response),
  };
}

/** An agent whose turn blocks on a permission request, then reports the choice. */
class BlockingAgent implements Agent {
  readonly capabilities = {};
  newSession(client: SessionClient): AgentSession {
    return {
      id: 'block-1',
      prompt: async (): Promise<PromptResponse> => {
        const answer = await client.requestPermission({
          toolCall: { toolCallId: 't1', title: 'delete the database' },
          options: [
            { optionId: 'ok', name: 'Allow', kind: 'allow_once' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        client.sessionUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'text',
            text: answer.outcome.outcome === 'selected' ? `did ${answer.outcome.optionId}` : 'cancelled',
          },
        });
        return { stopReason: 'end_turn' };
      },
      cancel: () => {},
      close: () => {},
    };
  }
}

describe('MailboxDelivery bootstrapping and completion', () => {
  it('bootstraps a run from an instruction and auto-posts its completion', async () => {
    const mailbox = new Mailbox();
    const registry = new RunRegistry({ agent: new EchoAgent(), mailbox });
    new MailboxDelivery(mailbox, registry);

    mailbox.post({ kind: 'instruction', text: 'fix the parser bug' });

    await vi.waitFor(() =>
      expect(mailbox.list().some((m) => m.kind === 'completion')).toBe(true),
    );
    const [summary] = registry.list();
    expect(summary?.title).toBe('fix the parser bug');
    const completion = mailbox.list().find((m) => m.kind === 'completion');
    expect(completion?.text).toBe('echo: fix the parser bug');
    expect(completion?.sessionId).toBe(summary?.sessionId);
    expect(completion?.direction).toBe('agent_to_user');
  });

  it('routes a bare instruction to the existing run rather than a second one', async () => {
    const mailbox = new Mailbox();
    const registry = new RunRegistry({ agent: new EchoAgent(), mailbox });
    new MailboxDelivery(mailbox, registry);
    const run = await registry.createRun({});

    mailbox.post({ kind: 'instruction', text: 'carry on' });

    await vi.waitFor(() =>
      expect(mailbox.list().some((m) => m.kind === 'completion')).toBe(true),
    );
    expect(registry.list()).toHaveLength(1);
    expect(mailbox.list().find((m) => m.kind === 'completion')?.sessionId).toBe(run.id);
  });
});

describe('MailboxDelivery blocked-on-question convention', () => {
  it('parks a permission request as a question, then a reply resumes the run', async () => {
    const mailbox = new Mailbox();
    const registry = new RunRegistry({ agent: new BlockingAgent(), mailbox });
    new MailboxDelivery(mailbox, registry);

    mailbox.post({ kind: 'instruction', text: 'clean up the workspace' });

    // The turn blocks: a question is posted and awaits a reply; the run stays
    // running and no completion is posted yet.
    await vi.waitFor(() => expect(mailbox.list().some((m) => m.kind === 'question')).toBe(true));
    const question = mailbox.list().find((m) => m.kind === 'question');
    expect(question?.awaitingReply).toBe(true);
    expect(question?.text).toContain('delete the database');
    const run = registry.list()[0];
    expect(registry.get(run!.sessionId)?.status).toBe('running');
    expect(mailbox.list().some((m) => m.kind === 'completion')).toBe(false);

    // The disconnected user answers later; the reply clears the question and the
    // parked turn proceeds to completion.
    mailbox.post({ text: 'allow', inReplyTo: question!.id });

    await vi.waitFor(() => expect(mailbox.list().some((m) => m.kind === 'completion')).toBe(true));
    expect(mailbox.get(question!.id)?.awaitingReply).toBe(false);
    expect(mailbox.list().find((m) => m.kind === 'completion')?.text).toBe('did ok');
    expect(registry.get(run!.sessionId)?.status).toBe('idle');
  });

  it('honors a negative reply by selecting the reject option', async () => {
    const mailbox = new Mailbox();
    const registry = new RunRegistry({ agent: new BlockingAgent(), mailbox });
    new MailboxDelivery(mailbox, registry);

    mailbox.post({ kind: 'instruction', text: 'go' });
    await vi.waitFor(() => expect(mailbox.list().some((m) => m.kind === 'question')).toBe(true));
    const question = mailbox.list().find((m) => m.kind === 'question');

    mailbox.post({ text: 'no, do not', inReplyTo: question!.id });

    await vi.waitFor(() => expect(mailbox.list().some((m) => m.kind === 'completion')).toBe(true));
    expect(mailbox.list().find((m) => m.kind === 'completion')?.text).toBe('did no');
  });
});

describe('MailboxDelivery per-tier delivery', () => {
  it('injects a queued instruction mid-run for an injectable (tier 1/2) agent', async () => {
    const mailbox = new Mailbox();
    const { agent, injected, prompts, finish } = controllableAgent({ injectable: true });
    const registry = new RunRegistry({ agent, mailbox });
    new MailboxDelivery(mailbox, registry);

    const run = await registry.createRun({});
    void run.prompt([{ type: 'text', text: 'start work' }], allow('ok'));
    await vi.waitFor(() => expect(registry.get(run.id)?.status).toBe('running'));

    mailbox.post({ kind: 'instruction', text: 'also update the changelog' });

    // Injected into the live turn — not queued for a later one.
    await vi.waitFor(() => expect(injected).toEqual(['also update the changelog']));
    expect(prompts).toEqual(['start work']);
    finish();
  });

  it('queues an instruction and prepends it to the next turn for a tier-3 agent', async () => {
    const mailbox = new Mailbox();
    const { agent, injected, prompts, finish } = controllableAgent({ injectable: false });
    const registry = new RunRegistry({ agent, mailbox });
    new MailboxDelivery(mailbox, registry);

    const run = await registry.createRun({});
    void run.prompt([{ type: 'text', text: 'first task' }], allow('ok'));
    await vi.waitFor(() => expect(registry.get(run.id)?.status).toBe('running'));

    // Arrives mid-run: a PTY-only agent has no injection channel, so it is held.
    mailbox.post({ kind: 'instruction', text: 'then this' });
    await Promise.resolve();
    expect(injected).toEqual([]);
    expect(prompts).toEqual(['first task']);

    // At the run boundary it is driven as the next turn.
    finish();
    await vi.waitFor(() => expect(prompts).toEqual(['first task', 'then this']));
    finish();
  });
});
