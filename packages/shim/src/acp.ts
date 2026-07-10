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

/** Extract the concatenated plain text from a prompt's content blocks. */
export function promptText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is TextContentBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
}
