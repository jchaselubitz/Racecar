/**
 * The durable per-sandbox mailbox: the set-and-forget surface that lets a user
 * supervise a sandbox without holding a live connection to it.
 *
 * Stage 4's premise is that the user disconnects entirely and comes back later,
 * so the mailbox cannot live only in a socket or in memory. It is the record of
 * the two-way traffic between user and agent — user→agent instructions and
 * replies, agent→user questions, updates, and completions — each carrying
 * read/unread state and, for a question, whether it still awaits a reply. It must
 * survive a sandbox stop/start, so it is event-sourced: every mutation appends a
 * line to a log ({@link MailboxPersistence}) that the daemon replays on boot to
 * rebuild the exact prior state. Appending is crash-safe in a way that rewriting a
 * whole document is not — a truncated final line is skipped, everything before it
 * stands.
 *
 * The store is pure of I/O: it folds events into state and emits changes to
 * observers ({@link MailboxObserver}). The daemon injects a file-backed
 * {@link MailboxPersistence}; tests inject an in-memory one. Northbound, one
 * {@link Mailbox} is shared across every connection (like the run registry), so a
 * question raised on one socket and a reply posted on another meet in the same
 * place — and any client subscribed to `mailbox/update` sees both live.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MailboxDirection, MailboxMessage, MailboxMessageKind } from './acp.js';

/** The kind a client is allowed to post: user→agent only. */
export type PostableKind = 'instruction' | 'reply';

/** Input to {@link Mailbox.post}. Direction is derived from the kind. */
export interface MailboxPostInput {
  /** Defaults to `instruction`; `inReplyTo` forces `reply`. */
  readonly kind?: MailboxMessageKind;
  readonly text: string;
  readonly sessionId?: string;
  readonly inReplyTo?: string;
}

/** Optional filters for {@link Mailbox.list}. */
export interface MailboxListFilter {
  readonly sessionId?: string;
  readonly unreadOnly?: boolean;
}

/**
 * A persisted mailbox mutation. The log is the source of truth; the in-memory
 * message map is a fold of these. `posted` carries the full message so a replay
 * reconstructs it verbatim; `read` and `answered` are the only fields that change
 * after a message exists.
 */
export type MailboxEvent =
  | { readonly t: 'posted'; readonly message: MailboxMessage }
  | { readonly t: 'read'; readonly id: string; readonly at: string }
  | { readonly t: 'answered'; readonly id: string; readonly at: string };

/** Durable backing for the mailbox event log. Injected so the store carries no I/O. */
export interface MailboxPersistence {
  /** Every event ever appended, in order. Called once at construction. */
  load(): readonly MailboxEvent[];
  /** Append one event durably. Must not lose earlier events on a crash. */
  append(event: MailboxEvent): void;
}

/** A subscriber notified of every added-or-changed message. Returns nothing. */
export type MailboxObserver = (message: MailboxMessage) => void;

/** Options for a {@link Mailbox}. */
export interface MailboxOptions {
  /** Durable backing; defaults to an in-memory log (nothing survives restart). */
  readonly persistence?: MailboxPersistence;
  /** Clock, injected for deterministic timestamps in tests. */
  readonly now?: () => Date;
}

/** Which direction a posted kind flows. */
function directionOf(kind: MailboxMessageKind): MailboxDirection {
  return kind === 'instruction' || kind === 'reply' ? 'user_to_agent' : 'agent_to_user';
}

let messageCounter = 0;

/** Mint a mailbox message id unique within a daemon process. */
function nextMessageId(): string {
  messageCounter += 1;
  return `msg-${Date.now().toString(36)}-${messageCounter.toString(36)}`;
}

/**
 * An in-memory mailbox folded from a durable event log. Every public mutation
 * appends before it returns, so the persisted log always reflects what callers
 * have observed. Reads return plain data snapshots — the internal message objects
 * are never handed out mutable.
 */
export class Mailbox {
  readonly #messages = new Map<string, MailboxMessage>();
  readonly #order: string[] = [];
  readonly #observers = new Set<MailboxObserver>();
  readonly #persist: MailboxPersistence;
  readonly #now: () => Date;

  constructor(options: MailboxOptions = {}) {
    this.#persist = options.persistence ?? new MemoryMailboxPersistence();
    this.#now = options.now ?? ((): Date => new Date());
    // Replay the durable log to rebuild the exact prior state. No observers exist
    // yet and nothing is re-appended, so replay is silent and idempotent.
    for (const event of this.#persist.load()) this.#apply(event);
  }

  /**
   * Post a message. A client posts `instruction`/`reply` (user→agent); the agent
   * side posts `question`/`update`/`completion` (agent→user). A `reply` — or any
   * post carrying `inReplyTo` — also clears the referenced question's
   * `awaitingReply`. Persists, then notifies observers of the new message (and of
   * the answered question, if any).
   */
  post(input: MailboxPostInput): MailboxMessage {
    const kind: MailboxMessageKind =
      input.inReplyTo !== undefined ? 'reply' : (input.kind ?? 'instruction');
    const message: MailboxMessage = {
      id: nextMessageId(),
      kind,
      direction: directionOf(kind),
      text: input.text,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
      ...(input.inReplyTo !== undefined ? { inReplyTo: input.inReplyTo } : {}),
      createdAt: this.#now().toISOString(),
      read: false,
      ...(kind === 'question' ? { awaitingReply: true } : {}),
    };
    this.#commit({ t: 'posted', message });
    if (input.inReplyTo !== undefined) this.#answer(input.inReplyTo);
    return this.#snapshot(message.id);
  }

  /**
   * Mark messages read. Unknown ids and already-read messages are skipped.
   * Returns the messages whose state actually changed (each also notified).
   */
  markRead(ids: readonly string[]): MailboxMessage[] {
    const changed: MailboxMessage[] = [];
    const at = this.#now().toISOString();
    for (const id of ids) {
      const message = this.#messages.get(id);
      if (message === undefined || message.read) continue;
      this.#commit({ t: 'read', id, at });
      changed.push(this.#snapshot(id));
    }
    return changed;
  }

  /** Snapshot every message, oldest first, optionally filtered. */
  list(filter: MailboxListFilter = {}): MailboxMessage[] {
    const messages = this.#order.map((id) => this.#messages.get(id)).filter(isMessage);
    return messages.filter((message) => {
      if (filter.sessionId !== undefined && message.sessionId !== filter.sessionId) return false;
      if (filter.unreadOnly === true && message.read) return false;
      return true;
    });
  }

  /** Look up one message by id, or undefined. */
  get(id: string): MailboxMessage | undefined {
    const message = this.#messages.get(id);
    return message === undefined ? undefined : { ...message };
  }

  /** Subscribe to added-or-changed messages. Returns an unsubscribe. */
  observe(observer: MailboxObserver): () => void {
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  /** Clear the referenced question's awaiting-reply flag, if it is a pending one. */
  #answer(questionId: string): void {
    const question = this.#messages.get(questionId);
    if (question === undefined || question.awaitingReply !== true) return;
    this.#commit({ t: 'answered', id: questionId, at: this.#now().toISOString() });
  }

  /** Persist an event, fold it into state, and notify observers of the change. */
  #commit(event: MailboxEvent): void {
    this.#persist.append(event);
    const changed = this.#apply(event);
    if (changed !== undefined) for (const observer of this.#observers) observer({ ...changed });
  }

  /** Fold one event into the message map. Returns the message it changed, if any. */
  #apply(event: MailboxEvent): MailboxMessage | undefined {
    switch (event.t) {
      case 'posted':
        if (!this.#messages.has(event.message.id)) this.#order.push(event.message.id);
        this.#messages.set(event.message.id, event.message);
        return event.message;
      case 'read': {
        const message = this.#messages.get(event.id);
        if (message === undefined) return undefined;
        const next = { ...message, read: true };
        this.#messages.set(event.id, next);
        return next;
      }
      case 'answered': {
        const message = this.#messages.get(event.id);
        if (message === undefined) return undefined;
        const next = { ...message, awaitingReply: false };
        this.#messages.set(event.id, next);
        return next;
      }
    }
  }

  #snapshot(id: string): MailboxMessage {
    const message = this.#messages.get(id);
    if (message === undefined) throw new Error(`mailbox message vanished: ${id}`);
    return { ...message };
  }
}

/** Narrow away the `undefined` a `Map.get` in a `.map` can introduce. */
function isMessage(message: MailboxMessage | undefined): message is MailboxMessage {
  return message !== undefined;
}

/** A non-durable {@link MailboxPersistence}: the default when none is injected. */
export class MemoryMailboxPersistence implements MailboxPersistence {
  readonly #events: MailboxEvent[] = [];
  load(): readonly MailboxEvent[] {
    return this.#events;
  }
  append(event: MailboxEvent): void {
    this.#events.push(event);
  }
}

/** Absolute path of the sandbox's durable mailbox log. */
export function mailboxPath(home: string): string {
  return `${home}/.racecar/mailbox.ndjson`;
}

/**
 * The production {@link MailboxPersistence}: an append-only NDJSON log at
 * `~/.racecar/mailbox.ndjson`. `load` tolerates a partial final line (a crash
 * mid-append) by skipping any line that does not parse, so the mailbox always
 * boots to the largest consistent prefix of its history.
 */
export function fileMailboxPersistence(env: NodeJS.ProcessEnv = process.env): MailboxPersistence {
  const path = mailboxPath(env.HOME ?? '/root');
  return {
    load: (): readonly MailboxEvent[] => {
      let raw: string;
      try {
        raw = readFileSync(path, 'utf8');
      } catch {
        return []; // No log yet: an empty mailbox is the correct cold-start state.
      }
      const events: MailboxEvent[] = [];
      for (const line of raw.split('\n')) {
        if (line.length === 0) continue;
        try {
          events.push(JSON.parse(line) as MailboxEvent);
        } catch {
          // A truncated final line from an interrupted append: drop it and stop —
          // nothing valid follows a partial write.
          break;
        }
      }
      return events;
    },
    append: (event: MailboxEvent): void => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(event)}\n`);
    },
  };
}
