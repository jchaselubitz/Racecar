import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { MailboxMessage } from './acp.js';
import {
  Mailbox,
  MemoryMailboxPersistence,
  fileMailboxPersistence,
  mailboxPath,
  type MailboxEvent,
} from './mailbox.js';

/** A clock advancing one second per call, for stable, ordered timestamps. */
function fakeClock(): () => Date {
  let t = Date.UTC(2026, 0, 1, 0, 0, 0);
  return () => {
    const now = new Date(t);
    t += 1000;
    return now;
  };
}

describe('Mailbox store', () => {
  it('posts an instruction as an unread user→agent message', () => {
    const mailbox = new Mailbox({ now: fakeClock() });
    const message = mailbox.post({ text: 'refactor the parser' });
    expect(message).toMatchObject({
      kind: 'instruction',
      direction: 'user_to_agent',
      text: 'refactor the parser',
      read: false,
    });
    expect(message.awaitingReply).toBeUndefined();
    expect(mailbox.list()).toHaveLength(1);
  });

  it('marks an agent question awaiting reply until a reply answers it', () => {
    const mailbox = new Mailbox({ now: fakeClock() });
    const question = mailbox.post({
      kind: 'question',
      text: 'which database?',
      sessionId: 'run-1',
    });
    expect(question.direction).toBe('agent_to_user');
    expect(question.awaitingReply).toBe(true);

    const reply = mailbox.post({ text: 'postgres', inReplyTo: question.id });
    expect(reply.kind).toBe('reply');
    expect(reply.direction).toBe('user_to_agent');
    expect(reply.inReplyTo).toBe(question.id);
    // The question it answers is no longer awaiting a reply.
    expect(mailbox.get(question.id)?.awaitingReply).toBe(false);
  });

  it('marks messages read idempotently and reports only real changes', () => {
    const mailbox = new Mailbox({ now: fakeClock() });
    const a = mailbox.post({ text: 'one' });
    const b = mailbox.post({ text: 'two' });
    const changed = mailbox.markRead([a.id, b.id, 'nope']);
    expect(changed.map((m) => m.id)).toEqual([a.id, b.id]);
    expect(mailbox.list({ unreadOnly: true })).toHaveLength(0);
    // Re-marking an already-read message reports no change.
    expect(mailbox.markRead([a.id])).toHaveLength(0);
  });

  it('filters by session and unread', () => {
    const mailbox = new Mailbox({ now: fakeClock() });
    const one = mailbox.post({ kind: 'update', text: 'a', sessionId: 'run-1' });
    mailbox.post({ kind: 'update', text: 'b', sessionId: 'run-2' });
    mailbox.markRead([one.id]);
    expect(mailbox.list({ sessionId: 'run-2' })).toHaveLength(1);
    expect(mailbox.list({ unreadOnly: true }).map((m) => m.text)).toEqual(['b']);
  });

  it('notifies observers of posts, reads, and answered questions', () => {
    const mailbox = new Mailbox({ now: fakeClock() });
    const seen: MailboxMessage[] = [];
    mailbox.observe((m) => seen.push(m));
    const question = mailbox.post({ kind: 'question', text: 'ok?' });
    mailbox.post({ text: 'yes', inReplyTo: question.id });
    mailbox.markRead([question.id]);
    // post(question), post(reply) + answered(question), read(question) = 4 events.
    expect(seen).toHaveLength(4);
    expect(seen[2]).toMatchObject({ id: question.id, awaitingReply: false });
    expect(seen[3]).toMatchObject({ id: question.id, read: true });
  });

  it('does not hand out mutable internals', () => {
    const mailbox = new Mailbox({ now: fakeClock() });
    const posted = mailbox.post({ text: 'x' });
    (posted as { read: boolean }).read = true;
    expect(mailbox.get(posted.id)?.read).toBe(false);
  });
});

describe('Mailbox durability via replay', () => {
  it('rebuilds exact state from a shared persistence log', () => {
    const persistence = new MemoryMailboxPersistence();
    const first = new Mailbox({ persistence, now: fakeClock() });
    const question = first.post({ kind: 'question', text: 'proceed?', sessionId: 'run-9' });
    const instruction = first.post({ text: 'also add tests' });
    first.post({ text: 'go', inReplyTo: question.id });
    first.markRead([instruction.id]);

    // A new mailbox over the same log — the stop/start of a sandbox — is identical.
    const revived = new Mailbox({ persistence });
    expect(revived.list()).toEqual(first.list());
    expect(revived.get(question.id)?.awaitingReply).toBe(false);
    expect(revived.get(instruction.id)?.read).toBe(true);
  });

  it('replay does not re-append or re-notify', () => {
    const persistence = new MemoryMailboxPersistence();
    new Mailbox({ persistence, now: fakeClock() }).post({ text: 'once' });
    const before = persistence.load().length;
    const seen: MailboxMessage[] = [];
    const revived = new Mailbox({ persistence });
    revived.observe((m) => seen.push(m));
    expect(persistence.load().length).toBe(before); // no duplicate events
    expect(seen).toHaveLength(0); // replay is silent
  });
});

describe('fileMailboxPersistence', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), 'racecar-mailbox-'));
    dirs.push(dir);
    return dir;
  }

  it('persists to ~/.racecar/mailbox.ndjson and reloads across instances', () => {
    const home = tempHome();
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const mailbox = new Mailbox({ persistence: fileMailboxPersistence(env) });
    const q = mailbox.post({ kind: 'question', text: 'y/n?' });
    mailbox.post({ text: 'y', inReplyTo: q.id });

    const raw = readFileSync(mailboxPath(home), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(3); // posted, posted, answered

    const revived = new Mailbox({ persistence: fileMailboxPersistence(env) });
    expect(revived.get(q.id)?.awaitingReply).toBe(false);
    expect(revived.list()).toHaveLength(2);
  });

  it('boots to an empty mailbox when no log exists', () => {
    const env = { HOME: tempHome() } as NodeJS.ProcessEnv;
    expect(new Mailbox({ persistence: fileMailboxPersistence(env) }).list()).toEqual([]);
  });

  it('drops a truncated trailing line from an interrupted append', () => {
    const home = tempHome();
    const env = { HOME: home } as NodeJS.ProcessEnv;
    const persistence = fileMailboxPersistence(env);
    const good: MailboxEvent = {
      t: 'posted',
      message: {
        id: 'msg-1',
        kind: 'instruction',
        direction: 'user_to_agent',
        text: 'kept',
        createdAt: '2026-01-01T00:00:00.000Z',
        read: false,
      },
    };
    persistence.append(good);
    // Simulate a crash mid-write: a partial JSON line with no newline.
    appendFileSync(mailboxPath(home), '{"t":"posted","mess');

    const mailbox = new Mailbox({ persistence: fileMailboxPersistence(env) });
    expect(mailbox.list().map((m) => m.text)).toEqual(['kept']);
  });
});
