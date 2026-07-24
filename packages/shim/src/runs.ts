/**
 * Shim-owned runs: the shared, observable session state that makes `racecar run`,
 * `racecar chat`, and `racecar attach` describe the *same* conversation.
 *
 * Objectives 1–2 gave every northbound connection its own agent and its own
 * sessions — correct for an isolated third-party ACP client, but it means two
 * Racecar clients watching one sandbox never see each other's run. This module is
 * the pivot the plan calls for ("the shim owns run state from here on"): one
 * shared {@link Agent} for the whole daemon, and a registry of {@link Run}s that
 * outlive the connection that created them. A run fans each streamed update out to
 * every observer and appends it to a transcript, so a client that joins mid-run
 * (via `session/attach`) is caught up and then live, and a transcript sink can
 * mirror the run into the tmux session `racecar attach` watches.
 *
 * Base ACP is unchanged: a run *is* an ACP session (its id is the session id, its
 * turns are `session/prompt` turns). The sharing is additive — the registry is
 * the seam, not a second protocol.
 */
import type {
  AgentCapabilities,
  ContentBlock,
  MailboxMessage,
  NewSessionRequest,
  PermissionOption,
  PromptResponse,
  RequestPermissionResponse,
  RunStatus,
  SessionSummary,
  SessionUpdate,
  StopReason,
} from './acp.js';
import { promptText } from './acp.js';
import type { Agent, AgentSession, PermissionRequest, SessionClient } from './agent.js';
import type { Mailbox } from './mailbox.js';

/** The party that answers a permission request for the current turn. */
export interface PermissionResponder {
  requestPermission(request: PermissionRequest): Promise<RequestPermissionResponse>;
}

/** A subscriber to a run's streamed updates (one per northbound connection). */
export type RunObserver = (update: SessionUpdate) => void;

/** Captured working-tree state at a turn boundary. */
export interface GitSummary {
  readonly gitStatus: string;
  readonly gitDiffStat: string;
}

/** Capture the run workspace's git state at turn end; injected so tests need no git. */
export type CaptureGit = (cwd: string | undefined) => Promise<GitSummary>;

/** A sink notified of each transcript entry, e.g. the tmux mirror. */
export type TranscriptSink = (runId: string, update: SessionUpdate) => void;

/** Options for a {@link RunRegistry}. */
export interface RunRegistryOptions {
  /** The single shared agent every run in this daemon multiplexes over. */
  readonly agent: Agent;
  /** Called for every streamed update on every run (mirror/transcript export). */
  readonly onTranscript?: TranscriptSink;
  /** Capture git state at each turn end; omitted means no summary is recorded. */
  readonly captureGit?: CaptureGit;
  /**
   * The durable mailbox runs post to and are driven from. When present, a run
   * auto-posts a `completion` at each natural turn end and a `question` when it
   * blocks on a permission request with no interactive client, and can be advanced
   * autonomously by a queued instruction. Omitted (as in unit tests that drive
   * runs directly) disables those conventions.
   */
  readonly mailbox?: Mailbox;
  /** Clock, injected for deterministic timestamps in tests. */
  readonly now?: () => Date;
}

/** Truncate a prompt to a short, single-line run title. */
function titleFrom(content: readonly ContentBlock[]): string {
  const text = promptText(content).replace(/\s+/g, ' ').trim();
  if (text.length === 0) return 'run';
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Longest a completion summary drawn from a turn's output runs before elision. */
const COMPLETION_TEXT_LIMIT = 280;

/** Concatenate the agent's message text streamed since `start` in `transcript`. */
function agentTextSince(transcript: readonly SessionUpdate[], start: number): string {
  return transcript
    .slice(start)
    .filter((update) => update.sessionUpdate === 'agent_message_chunk')
    .map((update) => (update.content.type === 'text' ? update.content.text : ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Elide `text` to {@link COMPLETION_TEXT_LIMIT} characters for a mailbox summary. */
function truncate(text: string): string {
  return text.length > COMPLETION_TEXT_LIMIT
    ? `${text.slice(0, COMPLETION_TEXT_LIMIT - 1)}…`
    : text;
}

/** Render a permission request as the human-facing text of a mailbox question. */
function questionTextFrom(request: PermissionRequest): string {
  return (
    `The agent is blocked and needs your approval to: “${request.toolCall.title}”. ` +
    `Reply “allow” to proceed or “reject” to decline.`
  );
}

const AFFIRMATIVE = /^(y|yes|ok|okay|allow|approve|proceed|go|sure|do it)\b/i;
const NEGATIVE = /^(n|no|reject|deny|decline|stop|cancel|don'?t)\b/i;

/**
 * Map a free-text mailbox reply onto one of a permission request's options. An
 * exact option id or name wins; otherwise an explicit negative selects the first
 * reject option and anything else (an affirmative, or an open answer meaning
 * "carry on") selects the first allow option. With no usable option the turn is
 * cancelled.
 */
function selectOutcome(
  options: readonly PermissionOption[],
  replyText: string,
): RequestPermissionResponse {
  const text = replyText.trim();
  const lower = text.toLowerCase();
  const exact =
    options.find((option) => option.optionId.toLowerCase() === lower) ??
    options.find((option) => option.name.toLowerCase() === lower);
  if (exact !== undefined) return { outcome: { outcome: 'selected', optionId: exact.optionId } };
  const reject = options.find((option) => option.kind.startsWith('reject'));
  if (NEGATIVE.test(text) && !AFFIRMATIVE.test(text) && reject !== undefined) {
    return { outcome: { outcome: 'selected', optionId: reject.optionId } };
  }
  const allow = options.find((option) => option.kind.startsWith('allow')) ?? options[0];
  return allow !== undefined
    ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/** A permission request parked on the mailbox, awaiting a reply to resolve it. */
interface PendingQuestion {
  /** The id of the posted `question` message a `reply` references. */
  readonly id: string;
  readonly options: readonly PermissionOption[];
  readonly resolve: (response: RequestPermissionResponse) => void;
}

/**
 * One shim-owned run: a single southbound {@link AgentSession} plus the shared
 * state around it — a transcript, a set of observers, status, and the git summary
 * captured at the last turn end.
 */
export class Run {
  readonly id: string;
  readonly createdAt: string;
  #session: AgentSession | undefined;
  readonly #observers = new Set<RunObserver>();
  readonly #transcript: SessionUpdate[] = [];
  readonly #onTranscript: TranscriptSink | undefined;
  readonly #captureGit: CaptureGit | undefined;
  readonly #mailbox: Mailbox | undefined;
  readonly #now: () => Date;
  readonly #cwd: string | undefined;
  #title: string;
  #status: RunStatus = 'idle';
  #updatedAt: string;
  #lastStopReason: StopReason | undefined;
  #git: GitSummary | undefined;
  /** The party that answers permission for the turn currently in flight, if any. */
  #prompter: PermissionResponder | undefined;
  /**
   * User→agent messages queued for the next turn boundary: tier-3 (PTY-only)
   * delivery, and any message delivered while no turn was running. Drained and
   * prepended at the start of the next turn.
   */
  readonly #pending: ContentBlock[][] = [];
  /** A permission this run parked on the mailbox as a question, awaiting a reply. */
  #pendingQuestion: PendingQuestion | undefined;
  /** Serializes turns so an interactive prompt and an autonomous drive never overlap. */
  #tail: Promise<void> = Promise.resolve();

  constructor(
    id: string,
    options: {
      readonly cwd?: string | undefined;
      readonly onTranscript?: TranscriptSink | undefined;
      readonly captureGit?: CaptureGit | undefined;
      readonly mailbox?: Mailbox | undefined;
      readonly now: () => Date;
    },
  ) {
    this.id = id;
    this.#cwd = options.cwd;
    this.#onTranscript = options.onTranscript;
    this.#captureGit = options.captureGit;
    this.#mailbox = options.mailbox;
    this.#now = options.now;
    this.createdAt = this.#now().toISOString();
    this.#updatedAt = this.createdAt;
    this.#title = 'run';
  }

  /** Bind the southbound session once the agent has minted it. */
  bind(session: AgentSession): void {
    this.#session = session;
  }

  #requireSession(): AgentSession {
    if (this.#session === undefined) throw new Error(`run ${this.id} has no session bound`);
    return this.#session;
  }

  /**
   * The {@link SessionClient} the run hands to the agent for its whole life:
   * updates fan out to observers and the transcript; permission routes to the
   * client that owns the in-flight turn (so an interactive `racecar chat` answers,
   * and a detached run answers by its own policy).
   */
  client(): SessionClient {
    return {
      sessionUpdate: (update: SessionUpdate): void => {
        this.#transcript.push(update);
        this.#updatedAt = this.#now().toISOString();
        this.#onTranscript?.(this.id, update);
        for (const observer of this.#observers) observer(update);
      },
      requestPermission: (request: PermissionRequest): Promise<RequestPermissionResponse> => {
        if (this.#prompter === undefined) {
          // No one owns the turn (e.g. a permission raced past turn end); decline
          // rather than hang the agent waiting on an answer that cannot come.
          return Promise.resolve({ outcome: { outcome: 'cancelled' } });
        }
        return this.#prompter.requestPermission(request);
      },
    };
  }

  get status(): RunStatus {
    return this.#status;
  }

  /** A point-in-time summary for `session/list` and `racecar runs`. */
  summary(): SessionSummary {
    return {
      sessionId: this.id,
      title: this.#title,
      status: this.#status,
      ...(this.#lastStopReason !== undefined ? { lastStopReason: this.#lastStopReason } : {}),
      createdAt: this.createdAt,
      updatedAt: this.#updatedAt,
      ...(this.#git !== undefined ? { gitStatus: this.#git.gitStatus } : {}),
      ...(this.#git !== undefined ? { gitDiffStat: this.#git.gitDiffStat } : {}),
    };
  }

  /**
   * Subscribe `observer` and replay the transcript so a late joiner is caught up
   * before the next live update. Returns an unsubscribe.
   */
  observe(observer: RunObserver): () => void {
    for (const update of this.#transcript) observer(update);
    this.#observers.add(observer);
    return () => this.#observers.delete(observer);
  }

  /**
   * Run one prompt turn. `prompter` answers any permission request the turn
   * raises. Turns are serialized (an interactive prompt and an autonomous mailbox
   * drive never run concurrently on the one southbound session), so this may wait
   * behind an in-flight turn before starting.
   */
  prompt(content: readonly ContentBlock[], prompter: PermissionResponder): Promise<PromptResponse> {
    return this.#runTurn(content, prompter);
  }

  /**
   * Deliver a user→agent mailbox message to this run. A `reply` to the run's
   * outstanding question resolves the blocked permission and lets the in-flight
   * turn proceed. Otherwise the message is fresh input: injected into the running
   * turn where the tier supports it (mid-run injection, tier 1/2), else queued and
   * prepended to the next turn (the run-boundary path for tier 3 and idle runs) —
   * which, when the run is idle, is driven immediately.
   */
  deliver(message: MailboxMessage): void {
    if (this.#pendingQuestion !== undefined && message.kind === 'reply') {
      this.#resolvePendingQuestion(message.text);
      return;
    }
    const content: ContentBlock[] = [{ type: 'text', text: message.text }];
    if (this.#status === 'running' && this.#session?.inject?.(content) === true) return;
    this.#pending.push(content);
    this.#maybeDrive();
  }

  /** Chain a turn behind any turn already running or queued, keeping them serial. */
  #runTurn(
    content: readonly ContentBlock[],
    prompter: PermissionResponder,
  ): Promise<PromptResponse> {
    const result = this.#tail.then(() => this.#executeTurn(content, prompter));
    // Keep the chain alive regardless of this turn's outcome, so a failed turn
    // does not wedge every later one.
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #executeTurn(
    content: readonly ContentBlock[],
    prompter: PermissionResponder,
  ): Promise<PromptResponse> {
    // Prepend anything queued for the next boundary (tier-3 delivery, messages that
    // arrived while idle), then run this prompt after it.
    const queued = this.#pending.splice(0).flat();
    const turnContent = queued.length > 0 ? [...queued, ...content] : content;
    // Nothing to say (an empty autonomous drive that raced a real turn): no-op.
    if (turnContent.length === 0) return { stopReason: 'end_turn' };
    if (this.#transcript.length === 0 && this.#title === 'run') {
      this.#title = titleFrom(turnContent);
    }
    const transcriptStart = this.#transcript.length;
    this.#prompter = prompter;
    this.#status = 'running';
    this.#updatedAt = this.#now().toISOString();
    try {
      const result = await this.#requireSession().prompt(turnContent);
      this.#lastStopReason = result.stopReason;
      if (result.stopReason === 'end_turn') this.#postCompletion(transcriptStart);
      return result;
    } finally {
      this.#prompter = undefined;
      this.#status = 'idle';
      this.#updatedAt = this.#now().toISOString();
      if (this.#captureGit !== undefined) {
        this.#git = await this.#captureGit(this.#cwd).catch(() => undefined);
      }
      // A message may have queued during the turn (tier-3, or a non-injectable
      // agent). Consume it now, at the run boundary.
      this.#maybeDrive();
    }
  }

  /** Auto-post a `completion` summarizing the turn's output, if a mailbox is set. */
  #postCompletion(transcriptStart: number): void {
    if (this.#mailbox === undefined) return;
    const summary = agentTextSince(this.#transcript, transcriptStart);
    this.#mailbox.post({
      kind: 'completion',
      text: summary.length > 0 ? truncate(summary) : 'Run completed.',
      sessionId: this.id,
    });
  }

  /** Drive a turn from the pending queue if the run is idle and something waits. */
  #maybeDrive(): void {
    if (this.#status === 'running') return;
    if (this.#pending.length === 0) return;
    void this.#runTurn([], this.#mailboxPrompter());
  }

  /** The permission responder for an autonomously-driven turn: ask via the mailbox. */
  #mailboxPrompter(): PermissionResponder {
    return {
      requestPermission: (request: PermissionRequest): Promise<RequestPermissionResponse> =>
        this.#askViaMailbox(request),
    };
  }

  /**
   * Blocked-on-question convention: with no interactive client to answer, post the
   * permission request as a durable `question` (awaiting reply) and park the turn
   * until a `reply` arrives. The disconnected user answers later; that reply
   * resolves the promise and the turn proceeds.
   */
  #askViaMailbox(request: PermissionRequest): Promise<RequestPermissionResponse> {
    const mailbox = this.#mailbox;
    if (mailbox === undefined) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    return new Promise<RequestPermissionResponse>((resolve) => {
      const question = mailbox.post({
        kind: 'question',
        text: questionTextFrom(request),
        sessionId: this.id,
      });
      this.#pendingQuestion = { id: question.id, options: request.options, resolve };
    });
  }

  /** Resolve the parked permission from a reply's text (see {@link selectOutcome}). */
  #resolvePendingQuestion(replyText: string): void {
    const pending = this.#pendingQuestion;
    if (pending === undefined) return;
    this.#pendingQuestion = undefined;
    pending.resolve(selectOutcome(pending.options, replyText));
  }

  /** Best-effort cancel of the in-flight turn. */
  cancel(): void {
    this.#session?.cancel();
  }

  /** Release the southbound session (the shared agent stays up for other runs). */
  close(): void {
    this.#status = 'ended';
    this.#session?.close();
  }
}

let runCounter = 0;

/** Mint a run id unique within a daemon process. */
function nextRunId(): string {
  runCounter += 1;
  return `run-${Date.now().toString(36)}-${runCounter.toString(36)}`;
}

/**
 * The daemon-wide registry of shim-owned runs over one shared {@link Agent}. All
 * northbound connections share it, so a run created by one is visible to and
 * joinable by another.
 */
export class RunRegistry {
  readonly #agent: Agent;
  readonly #runs = new Map<string, Run>();
  readonly #onTranscript: TranscriptSink | undefined;
  readonly #captureGit: CaptureGit | undefined;
  readonly #mailbox: Mailbox | undefined;
  readonly #now: () => Date;

  constructor(options: RunRegistryOptions) {
    this.#agent = options.agent;
    this.#onTranscript = options.onTranscript;
    this.#captureGit = options.captureGit;
    this.#mailbox = options.mailbox;
    this.#now = options.now ?? (() => new Date());
  }

  /** Await the shared agent's readiness (a subprocess adapter's handshake). */
  ready(): Promise<void> {
    return this.#agent.ready?.() ?? Promise.resolve();
  }

  /** Capabilities to surface northbound (the shared agent's). */
  get capabilities(): AgentCapabilities {
    return this.#agent.capabilities;
  }

  /** Create a run: mint a southbound session on the shared agent and register it. */
  async createRun(params: NewSessionRequest): Promise<Run> {
    await this.ready();
    const run = new Run(nextRunId(), {
      cwd: params.cwd,
      onTranscript: this.#onTranscript,
      captureGit: this.#captureGit,
      mailbox: this.#mailbox,
      now: this.#now,
    });
    // The run's client is stable and independent of the session, so it can be
    // handed to the agent before the session exists — an update streamed during
    // session creation still lands on this run's transcript.
    const session = await this.#agent.newSession(run.client(), params);
    run.bind(session);
    this.#runs.set(run.id, run);
    return run;
  }

  /** Look up a run by id. */
  get(runId: string): Run | undefined {
    return this.#runs.get(runId);
  }

  /** The most recently created run, or undefined if none exist yet. */
  latest(): Run | undefined {
    let newest: Run | undefined;
    for (const run of this.#runs.values()) {
      if (newest === undefined || run.createdAt > newest.createdAt) newest = run;
    }
    return newest;
  }

  /** Summaries of every run, newest last. */
  list(): SessionSummary[] {
    return [...this.#runs.values()]
      .map((run) => run.summary())
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  /** Close every run and release the shared agent (daemon shutdown). */
  close(): void {
    for (const run of this.#runs.values()) run.close();
    this.#runs.clear();
    this.#agent.close?.();
  }
}
