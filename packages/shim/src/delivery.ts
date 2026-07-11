/**
 * Mailbox → run delivery: the southbound half of the mailbox, routing the
 * user→agent traffic to the agent according to its tier.
 *
 * Objective 1 built the durable store and its northbound ACP surface; a user can
 * post an instruction or a reply and walk away. This module closes the loop: it
 * watches the mailbox and, for each user→agent message, finds the run it concerns
 * and hands it over. The *tier* mechanics live on the {@link Run} — mid-run
 * injection for tier 1/2, run-boundary prepend for tier 3 — so this service is
 * only the router: it resolves the target run, bootstrapping one when an
 * instruction arrives at a sandbox with no run yet (the set-and-forget premise:
 * the user drops an instruction and the agent starts working on it), and leaves
 * the delivery semantics to {@link Run.deliver}.
 *
 * The mailbox notifies observers on every add *and* every state change (a message
 * marked read re-notifies), so delivery is idempotent per message id — a message
 * is handed to its run exactly once. Handling is serialized through a promise
 * chain so two instructions arriving before the first bootstraps a run cannot each
 * create their own.
 *
 * Delivery is live-only: it acts on messages as they are posted, not on the
 * persisted backlog at boot. A restart loses a run's in-memory turn (the agent
 * subprocess is gone), so re-driving old instructions from history would re-run
 * already-consumed work; and since the WebSocket is down while the daemon is
 * stopped, no message can arrive except while delivery is live to see it.
 */
import type { MailboxMessage } from './acp.js';
import type { Mailbox } from './mailbox.js';
import type { Run, RunRegistry } from './runs.js';

/**
 * Routes durable mailbox messages to runs. Constructed once per daemon over the
 * shared {@link Mailbox} and {@link RunRegistry}; subscribes for the mailbox's
 * lifetime (the daemon owns both, so there is nothing to unsubscribe).
 */
export class MailboxDelivery {
  readonly #mailbox: Mailbox;
  readonly #registry: RunRegistry;
  /** Message ids already delivered, so a re-notify (e.g. mark-read) is ignored. */
  readonly #delivered = new Set<string>();
  /** Serializes handling so concurrent instructions share one bootstrapped run. */
  #tail: Promise<void> = Promise.resolve();

  constructor(mailbox: Mailbox, registry: RunRegistry) {
    this.#mailbox = mailbox;
    this.#registry = registry;
    this.#mailbox.observe((message) => this.#onMessage(message));
  }

  #onMessage(message: MailboxMessage): void {
    if (!isUserToAgent(message)) return;
    if (this.#delivered.has(message.id)) return;
    this.#delivered.add(message.id);
    this.#tail = this.#tail.then(() => this.#handle(message)).catch(() => undefined);
  }

  async #handle(message: MailboxMessage): Promise<void> {
    let run = this.#resolve(message);
    if (run === undefined) {
      // A reply with no run to answer (its question's run is gone) is dropped; an
      // instruction with no run bootstraps one so the agent starts on it.
      if (message.kind === 'reply') return;
      run = await this.#registry.createRun({});
    }
    run.deliver(message);
  }

  /**
   * Find the run a message concerns: an explicit `sessionId`, else the run of the
   * question a `reply` answers, else the most recent still-open run.
   */
  #resolve(message: MailboxMessage): Run | undefined {
    if (message.sessionId !== undefined) return this.#registry.get(message.sessionId);
    if (message.inReplyTo !== undefined) {
      const question = this.#mailbox.get(message.inReplyTo);
      if (question?.sessionId !== undefined) return this.#registry.get(question.sessionId);
    }
    const latest = this.#registry.latest();
    return latest !== undefined && latest.status !== 'ended' ? latest : undefined;
  }
}

/** Whether a message flows user→agent and is a deliverable instruction or reply. */
function isUserToAgent(message: MailboxMessage): boolean {
  return (
    message.direction === 'user_to_agent' &&
    (message.kind === 'instruction' || message.kind === 'reply')
  );
}
