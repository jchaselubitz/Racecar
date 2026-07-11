/**
 * The Agent Client Protocol (ACP) surface the shim speaks northbound.
 *
 * ACP is a JSON-RPC 2.0 protocol between a *client* (an editor, or
 * `racecar chat`) and an *agent*. The shim is the **agent** here: a third-party
 * ACP client connects over the sandbox's preview-URL WebSocket and drives a
 * session. Southbound, the shim is in turn an ACP client of the real agent
 * (Claude Code / Codex) — that side, and the capability flags it surfaces, land
 * in the next objective; this module defines the northbound method names and the
 * message shapes the shim server implements today.
 *
 * The subset here is deliberately faithful to ACP but small: initialize, session
 * lifecycle, prompt turns, streamed session updates, and permission requests —
 * the messages a client needs to hold a conversation. It is typed structurally
 * (not imported from an SDK) so this transport layer carries no agent dependency.
 */

/** ACP protocol version this shim implements. Integer, per the ACP schema. */
export const ACP_PROTOCOL_VERSION = 1;

/** ACP method names. `session/update` is a notification; the rest are requests. */
export const AcpMethod = {
  /** Client → agent: negotiate protocol version and exchange capabilities. */
  initialize: 'initialize',
  /** Client → agent: begin a new conversation session. */
  newSession: 'session/new',
  /** Client → agent: send a prompt turn; resolves when the turn stops. */
  prompt: 'session/prompt',
  /** Client → agent: cancel the in-flight turn for a session. */
  cancel: 'session/cancel',
  /** Agent → client (notification): a streamed update within a turn. */
  update: 'session/update',
  /** Agent → client (request): ask the user to authorize an action. */
  requestPermission: 'session/request_permission',
  /**
   * Client → agent (Racecar extension): list the sessions the shim currently
   * owns, so a second client can discover a run already in flight. Not part of
   * base ACP — a generic client simply never calls it — but it is how
   * `racecar chat` finds the run `racecar run` started, and how two clients come
   * to supervise the same run. See {@link ListSessionsResponse}.
   */
  listSessions: 'session/list',
  /**
   * Client → agent (Racecar extension): subscribe to an existing session by id,
   * receiving its transcript replayed as `session/update` notifications and then
   * every live update. This is the join that lets `racecar chat` and a run share
   * one session. See {@link AttachSessionRequest}.
   */
  attachSession: 'session/attach',
  /**
   * Client → agent (Racecar extension): list the sandbox's durable mailbox
   * messages, so a client that reconnects after any absence is caught up on the
   * user→agent instructions and agent→user questions/updates/completions that
   * accumulated while it was gone. See {@link MailboxListResponse}.
   */
  mailboxList: 'mailbox/list',
  /**
   * Client → agent (Racecar extension): post a user→agent message to the mailbox
   * — an instruction, or a reply that answers a pending question. Durable and
   * observed by every connection. See {@link MailboxPostRequest}.
   */
  mailboxPost: 'mailbox/post',
  /**
   * Client → agent (Racecar extension): mark mailbox messages read, clearing the
   * unread badge across every connected client. See {@link MailboxMarkReadRequest}.
   */
  mailboxMarkRead: 'mailbox/mark_read',
  /**
   * Agent → client (notification, Racecar extension): a mailbox message was
   * added or changed. Every connection is subscribed, so a mobile/web client that
   * simply holds the socket open sees new questions and completions live, and a
   * `racecar inbox` refreshes without polling. See {@link MailboxUpdateNotification}.
   */
  mailboxUpdate: 'mailbox/update',
} as const;

/** A single piece of prompt/response content. Text is the tier-1 shape. */
export interface TextContentBlock {
  readonly type: 'text';
  readonly text: string;
}

/** Content blocks the shim understands on the wire (text for now). */
export type ContentBlock = TextContentBlock;

/** Capabilities a client advertises to the agent in {@link InitializeRequest}. */
export interface ClientCapabilities {
  readonly fs?: { readonly readTextFile?: boolean; readonly writeTextFile?: boolean };
  readonly terminal?: boolean;
}

/** Capabilities the agent advertises back. Populated by adapters in objective 2. */
export interface AgentCapabilities {
  /** Whether the agent accepts prompts that load session context from history. */
  readonly loadSession?: boolean;
  /** Prompt content types the agent accepts beyond plain text. */
  readonly promptCapabilities?: {
    readonly image?: boolean;
    readonly audio?: boolean;
    readonly embeddedContext?: boolean;
  };
}

/** `initialize` params (client → agent). */
export interface InitializeRequest {
  readonly protocolVersion: number;
  readonly clientCapabilities?: ClientCapabilities;
}

/** `initialize` result (agent → client). */
export interface InitializeResponse {
  readonly protocolVersion: number;
  readonly agentCapabilities: AgentCapabilities;
  /** Auth methods the agent offers; empty because the shim gates auth itself. */
  readonly authMethods: readonly never[];
}

/** `session/new` params. `cwd` is the working directory for the session. */
export interface NewSessionRequest {
  readonly cwd?: string;
  readonly mcpServers?: readonly unknown[];
}

/** `session/new` result: the id subsequent calls carry. */
export interface NewSessionResponse {
  readonly sessionId: string;
}

/** `session/prompt` params. */
export interface PromptRequest {
  readonly sessionId: string;
  readonly prompt: readonly ContentBlock[];
}

/** Why a prompt turn stopped, per ACP. */
export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** `session/prompt` result. */
export interface PromptResponse {
  readonly stopReason: StopReason;
}

/** `session/cancel` params (a notification). */
export interface CancelNotification {
  readonly sessionId: string;
}

/** The payload variants of a `session/update` notification. */
export type SessionUpdate =
  | { readonly sessionUpdate: 'agent_message_chunk'; readonly content: ContentBlock }
  | { readonly sessionUpdate: 'agent_thought_chunk'; readonly content: ContentBlock }
  | { readonly sessionUpdate: 'user_message_chunk'; readonly content: ContentBlock }
  | {
      readonly sessionUpdate: 'tool_call';
      readonly toolCallId: string;
      readonly title: string;
      readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
    };

/** `session/update` notification params (agent → client). */
export interface SessionUpdateNotification {
  readonly sessionId: string;
  readonly update: SessionUpdate;
}

/** One option offered in a {@link RequestPermissionRequest}. */
export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}

/** `session/request_permission` params (agent → client). */
export interface RequestPermissionRequest {
  readonly sessionId: string;
  readonly toolCall: { readonly toolCallId: string; readonly title: string };
  readonly options: readonly PermissionOption[];
}

/** `session/request_permission` result (client → agent). */
export interface RequestPermissionResponse {
  readonly outcome:
    { readonly outcome: 'selected'; readonly optionId: string } | { readonly outcome: 'cancelled' };
}

/**
 * Lifecycle state of a shim-owned run (Racecar extension). A run is idle before
 * its first prompt, running while a turn is in flight, and ended once its owning
 * client has finished with it.
 */
export type RunStatus = 'idle' | 'running' | 'ended';

/**
 * A summary of one shim-owned session/run (Racecar extension), returned by
 * `session/list`. Carries enough to render a run picker and a `racecar runs`
 * table without holding the session open.
 */
export interface SessionSummary {
  readonly sessionId: string;
  /** Human label — the first prompt's text, truncated — for a run picker. */
  readonly title: string;
  readonly status: RunStatus;
  /** Why the last turn stopped, once one has. */
  readonly lastStopReason?: StopReason;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** `git status --porcelain` captured at the last turn end (empty if clean). */
  readonly gitStatus?: string;
  /** `git diff --stat` captured at the last turn end. */
  readonly gitDiffStat?: string;
}

/** `session/list` result (Racecar extension). */
export interface ListSessionsResponse {
  readonly sessions: readonly SessionSummary[];
}

/** `session/attach` params (Racecar extension): the session to observe. */
export interface AttachSessionRequest {
  readonly sessionId: string;
}

/** `session/attach` result (Racecar extension): the joined session's summary. */
export interface AttachSessionResponse {
  readonly session: SessionSummary;
}

/**
 * Which way a mailbox message flows. `user_to_agent` is an instruction or a
 * reply the user queued for the agent; `agent_to_user` is a question, update, or
 * completion the agent raised for the user.
 */
export type MailboxDirection = 'user_to_agent' | 'agent_to_user';

/**
 * The kind of a mailbox message. The direction is implied by the kind
 * (`instruction`/`reply` are user→agent; `question`/`update`/`completion` are
 * agent→user) but carried explicitly so a client renders an inbox without a
 * lookup table.
 */
export type MailboxMessageKind =
  | 'instruction'
  | 'reply'
  | 'question'
  | 'update'
  | 'completion';

/**
 * One durable mailbox message (Racecar extension). Persisted per sandbox and
 * replayed across stop/start, so the mailbox is the set-and-forget surface a
 * disconnected user returns to.
 */
export interface MailboxMessage {
  readonly id: string;
  readonly kind: MailboxMessageKind;
  readonly direction: MailboxDirection;
  readonly text: string;
  /** The run/session this message concerns, when it was raised within one. */
  readonly sessionId?: string;
  /**
   * For a `reply`, the id of the `question` it answers. Posting it clears that
   * question's {@link awaitingReply}.
   */
  readonly inReplyTo?: string;
  readonly createdAt: string;
  /** Whether the recipient has marked this message read. */
  readonly read: boolean;
  /**
   * For a `question`, whether it still awaits a reply. Undefined for other kinds.
   * Flips to `false` once a `reply` referencing it is posted.
   */
  readonly awaitingReply?: boolean;
}

/** `mailbox/list` params: optional filters (Racecar extension). */
export interface MailboxListRequest {
  /** Restrict to messages concerning this session. */
  readonly sessionId?: string;
  /** Restrict to unread messages. */
  readonly unreadOnly?: boolean;
}

/** `mailbox/list` result (Racecar extension). */
export interface MailboxListResponse {
  readonly messages: readonly MailboxMessage[];
}

/**
 * `mailbox/post` params (Racecar extension). A client posts user→agent messages
 * only: an `instruction`, or a `reply` (pass `inReplyTo`). `kind` defaults to
 * `instruction`; passing `inReplyTo` implies `reply`.
 */
export interface MailboxPostRequest {
  readonly text: string;
  readonly kind?: 'instruction' | 'reply';
  readonly sessionId?: string;
  readonly inReplyTo?: string;
}

/** `mailbox/post` result: the created message (Racecar extension). */
export interface MailboxPostResponse {
  readonly message: MailboxMessage;
}

/** `mailbox/mark_read` params (Racecar extension). */
export interface MailboxMarkReadRequest {
  readonly messageIds: readonly string[];
}

/** `mailbox/mark_read` result: the messages whose read state changed. */
export interface MailboxMarkReadResponse {
  readonly messages: readonly MailboxMessage[];
}

/**
 * `mailbox/update` notification params (agent → client, Racecar extension): the
 * message that was added or changed. A client folds it into its local view by id.
 */
export interface MailboxUpdateNotification {
  readonly message: MailboxMessage;
}

/** Extract the concatenated plain text from a prompt's content blocks. */
export function promptText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is TextContentBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
