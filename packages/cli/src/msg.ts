/**
 * `racecar msg send`, `racecar msg reply`, and `racecar inbox` — the CLI half of
 * the Stage 4 mailbox.
 *
 * The mailbox lives in each sandbox's shim (durable across stop/start) and is
 * reachable over the same authenticated ACP WebSocket a chat/run uses, via the
 * Racecar `mailbox/*` extensions on {@link AcpClient}. This module is the
 * set-and-forget client surface over that: `msg send` queues a user→agent
 * instruction, `msg reply` answers an agent's question (which unblocks a parked
 * run), and `inbox` aggregates every sandbox's mailbox into one view so a user who
 * disconnected entirely can return and see, across all their sandboxes at once,
 * what completed, what is asking a question, and what is still running.
 *
 * Each operation is a short-lived connection: connect, initialize, do the one
 * mailbox call, disconnect. The shim keeps owning the mailbox and the run, so
 * nothing is lost when the socket closes — that is the whole point of Stage 4.
 */
import { connectShim, type ShimConnection } from './shim-connect.js';
import type { AcpClient, MailboxMessage } from '@racecar/shim';
import {
  toSandboxes,
  sandboxLabelSelector,
  type Sandbox,
  type SandboxProvider,
} from '@racecar/core';

/** One sandbox's slice of the aggregated inbox. */
export interface SandboxInbox {
  readonly sandbox: Sandbox;
  readonly messages: readonly MailboxMessage[];
  /**
   * How many of the sandbox's runs are still in flight. A run that is working but
   * has posted nothing to the mailbox yet would otherwise be invisible; this is
   * what makes "still running" distinguishable from "done" or "idle" in the inbox.
   */
  readonly running: number;
  /** Set when the sandbox's mailbox could not be read (e.g. it is not started). */
  readonly error?: string;
}

/** Filters for {@link collectInbox}. */
export interface InboxFilter {
  /** Restrict to one project's sandboxes. */
  readonly project?: string;
  /** Restrict to a single sandbox id. */
  readonly sandbox?: string;
  /** Only return unread messages. */
  readonly unreadOnly?: boolean;
}

/**
 * Connect to a sandbox's shim, initialize, run one mailbox call, and disconnect.
 * The shim retains the mailbox and any run, so tearing the socket down is safe.
 */
async function withShim<T>(
  provider: SandboxProvider,
  sandboxId: string,
  fn: (client: AcpClient) => Promise<T>,
): Promise<T> {
  const connection: ShimConnection = await connectShim(provider, sandboxId);
  try {
    await connection.client.initialize();
    return await fn(connection.client);
  } finally {
    connection.close();
    await connection.closed.catch(() => {});
  }
}

/**
 * Queue a user→agent instruction on `sandboxId`'s mailbox. With no client
 * attached the shim's delivery layer still drives it (objective 2), so this is
 * genuine set-and-forget supervision. Returns the created message.
 */
export async function sendInstruction(
  provider: SandboxProvider,
  sandboxId: string,
  text: string,
  options: { readonly session?: string } = {},
): Promise<MailboxMessage> {
  return withShim(provider, sandboxId, (client) =>
    client.mailboxPost({
      text,
      ...(options.session !== undefined ? { sessionId: options.session } : {}),
    }),
  );
}

/**
 * Answer an agent's question by posting a reply that references it. Posting the
 * reply clears the question's awaiting-reply flag and, when the run parked on that
 * question, lets it proceed (objective 2's blocked-on-question convention).
 */
export async function replyToMessage(
  provider: SandboxProvider,
  sandboxId: string,
  inReplyTo: string,
  text: string,
): Promise<MailboxMessage> {
  return withShim(provider, sandboxId, (client) => client.mailboxPost({ text, inReplyTo }));
}

/**
 * Aggregate the mailbox of every managed sandbox (optionally filtered) into a
 * per-sandbox view. A sandbox that is not started has a live shim, so its mailbox
 * cannot be read right now; it is returned with an `error` rather than dropped, so
 * the user still sees it exists. Reads run concurrently and one sandbox's failure
 * never sinks the others.
 */
export async function collectInbox(
  provider: SandboxProvider,
  filter: InboxFilter = {},
): Promise<readonly SandboxInbox[]> {
  const managed = toSandboxes(
    await provider.listSandboxes({
      labels: sandboxLabelSelector(
        filter.project === undefined ? undefined : { project: filter.project },
      ),
    }),
  );
  const selected =
    filter.sandbox === undefined
      ? managed
      : managed.filter((sandbox) => sandbox.id === filter.sandbox);
  return Promise.all(
    selected.map(async (sandbox): Promise<SandboxInbox> => {
      if (sandbox.state !== 'started') {
        return {
          sandbox,
          messages: [],
          running: 0,
          error: `sandbox is ${sandbox.state}; start it to read its mailbox`,
        };
      }
      try {
        return await withShim(provider, sandbox.id, async (client) => {
          // Read the mailbox and the run list on the one connection: the messages
          // carry completions/questions, and the run list reveals a run still
          // working silently (the "still running" the exit criteria asks for).
          const messages = await client.mailboxList(
            filter.unreadOnly === true ? { unreadOnly: true } : {},
          );
          const running = (await client.listSessions()).filter(
            (session) => session.status === 'running',
          ).length;
          return { sandbox, messages, running };
        });
      } catch (error) {
        return {
          sandbox,
          messages: [],
          running: 0,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
}

/** Render one mailbox message as an indented, unread/awaiting-annotated block. */
export function formatMailboxMessage(message: MailboxMessage): string {
  const unread = message.read ? ' ' : '●';
  const awaiting = message.awaitingReply === true ? '  (awaiting reply)' : '';
  const head = `  ${unread} ${message.kind.padEnd(10)} ${message.id}  ${message.createdAt}${awaiting}`;
  const body = message.text
    .split('\n')
    .map((line) => `        ${line}`)
    .join('\n');
  return `${head}\n${body}`;
}

/** Render the aggregated inbox as a per-sandbox, human-readable report. */
export function formatInbox(inboxes: readonly SandboxInbox[]): string {
  if (inboxes.length === 0) return 'no managed sandboxes\n';
  const blocks = inboxes.map((box) => {
    const { sandbox } = box;
    const running = box.running > 0 ? `  (${box.running} running)` : '';
    const header = `${sandbox.id}  ${sandbox.project}/${sandbox.mission}  [${sandbox.state}]${running}`;
    if (box.error !== undefined) return `${header}\n  (${box.error})`;
    if (box.messages.length === 0) {
      return box.running > 0 ? header : `${header}\n  (no messages)`;
    }
    return [header, ...box.messages.map(formatMailboxMessage)].join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

/** The NDJSON shape for one mailbox message under a sandbox. */
export function mailboxMessageEvent(
  sandboxId: string,
  message: MailboxMessage,
): Record<string, unknown> {
  return {
    sandbox: sandboxId,
    messageId: message.id,
    kind: message.kind,
    direction: message.direction,
    text: message.text,
    sessionId: message.sessionId ?? null,
    inReplyTo: message.inReplyTo ?? null,
    read: message.read,
    awaitingReply: message.awaitingReply ?? null,
    createdAt: message.createdAt,
  };
}
