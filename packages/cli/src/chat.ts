/**
 * `racecar chat <sandbox>` — a terminal chat client over the sandbox's shim.
 *
 * It is an ACP client of the shim (see {@link connectShim}): it initializes,
 * then either creates a run or attaches to one already in flight, and runs a
 * turn-based REPL — the user types a prompt, the agent's streamed reply prints as
 * it arrives, and the turn ends when the agent stops. Two things make this more
 * than a toy: it renders `session/update` streams live, and it answers
 * `session/request_permission` by prompting the operator to allow or reject, which
 * is how a human supervises a tool-using agent from the terminal.
 *
 * Because the run lives in the shim, not this process, a chat and a `racecar
 * attach` (which watches the tmux transcript mirror) supervise the *same* run at
 * once, and quitting chat leaves the run running for the next client.
 */
import { createInterface } from 'node:readline';
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionSummary,
  SessionUpdate,
  SessionUpdateNotification,
} from '@racecar/shim';
import { textBlocks } from '@racecar/shim';
import type { SandboxProvider } from '@racecar/core';
import { connectShim, type ShimConnection } from './shim-connect.js';
import { emitEvent, isJsonMode } from './output.js';

/** Options for {@link chatWithSandbox}. */
export interface ChatOptions {
  /** Attach to this existing run id instead of creating a new one. */
  readonly run?: string;
  /** Working directory for a newly created run. */
  readonly cwd?: string;
  /** Send this single prompt, print the reply, and exit (non-interactive). */
  readonly prompt?: string;
  /** IO streams, injected for tests; default to the process streams. */
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
}

/**
 * Render one streamed update for the chat display, or `undefined` for an update
 * with nothing to show. Distinct from the tmux mirror's renderer: here agent text
 * streams inline (no trailing newline) so a reply reads as one flowing message.
 */
export function renderChatUpdate(
  update: SessionUpdate,
): { text: string; newline: boolean } | undefined {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return update.content.type === 'text'
        ? { text: update.content.text, newline: false }
        : undefined;
    case 'agent_thought_chunk':
      return update.content.type === 'text'
        ? { text: `\x1b[2m${update.content.text}\x1b[0m`, newline: false }
        : undefined;
    case 'tool_call':
      return { text: `\n[tool ${update.status}] ${update.title}`, newline: true };
    default:
      return undefined;
  }
}

/** Format a permission request into a prompt line and its option keys. */
export function formatPermission(request: RequestPermissionRequest): {
  readonly lines: string[];
  readonly options: readonly PermissionOption[];
} {
  const lines = [`\n[permission] the agent wants to: ${request.toolCall.title}`];
  request.options.forEach((option, index) => {
    lines.push(`  ${index + 1}) ${option.name} (${option.kind})`);
  });
  lines.push('Choose an option [1]: ');
  return { lines, options: request.options };
}

/** Map a user's answer (1-based index or option name) to a permission outcome. */
export function resolvePermissionChoice(
  answer: string,
  options: readonly PermissionOption[],
): RequestPermissionResponse {
  const trimmed = answer.trim();
  if (trimmed.length === 0) {
    const first = options[0];
    return first !== undefined
      ? { outcome: { outcome: 'selected', optionId: first.optionId } }
      : { outcome: { outcome: 'cancelled' } };
  }
  const index = Number(trimmed);
  if (Number.isInteger(index) && index >= 1 && index <= options.length) {
    return { outcome: { outcome: 'selected', optionId: options[index - 1]!.optionId } };
  }
  const byName = options.find(
    (option) => option.name.toLowerCase() === trimmed.toLowerCase() || option.optionId === trimmed,
  );
  return byName !== undefined
    ? { outcome: { outcome: 'selected', optionId: byName.optionId } }
    : { outcome: { outcome: 'cancelled' } };
}

/**
 * Open a chat session against `sandboxId`'s shim and run it to completion (a
 * single prompt with {@link ChatOptions.prompt}, or an interactive REPL until the
 * user exits).
 */
export async function chatWithSandbox(
  provider: SandboxProvider,
  sandboxId: string,
  options: ChatOptions = {},
): Promise<void> {
  const out = options.output ?? process.stdout;
  const write = (text: string): void => void out.write(text);

  // A readline interface serves both the REPL prompt and permission questions.
  const rl = createInterface({
    input: options.input ?? process.stdin,
    output: out,
    terminal: false,
  });
  const ask = (query: string): Promise<string> =>
    new Promise((resolve) => rl.question(query, resolve));

  let atLineStart = true;
  const onUpdate = (notification: SessionUpdateNotification): void => {
    const rendered = renderChatUpdate(notification.update);
    if (rendered === undefined) return;
    if (isJsonMode()) {
      emitEvent('chat.update', { sandbox: sandboxId, update: notification.update });
      return;
    }
    write(rendered.text);
    if (rendered.newline) write('\n');
    atLineStart = rendered.newline;
  };
  const onPermission = async (
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> => {
    const { lines, options: opts } = formatPermission(request);
    if (!atLineStart) write('\n');
    const answer = await ask(lines.join('\n'));
    return resolvePermissionChoice(answer, opts);
  };

  let connection: ShimConnection;
  try {
    connection = await connectShim(provider, sandboxId, { handlers: { onUpdate, onPermission } });
  } catch (error) {
    rl.close();
    throw error;
  }
  const { client, close } = connection;

  try {
    await client.initialize();
    const sessionId = await resolveSession(client, options, write);
    emitEvent('chat.session', { sandbox: sandboxId, sessionId });

    if (options.prompt !== undefined) {
      await runTurn(client, sessionId, options.prompt, write);
      return;
    }
    if (!isJsonMode()) {
      write(`Connected to run ${sessionId}. Type a message; Ctrl-D or ".exit" to leave.\n`);
    }
    for (;;) {
      const line = await ask('\nyou> ');
      const text = line.trim();
      if (text === '.exit' || text === '.quit') break;
      if (text.length === 0) continue;
      atLineStart = true;
      await runTurn(client, sessionId, text, write);
    }
  } finally {
    rl.close();
    close();
    await connection.closed.catch(() => {});
  }
}

/** Decide which run to use: an explicit id, else a fresh run. */
async function resolveSession(
  client: ShimConnection['client'],
  options: ChatOptions,
  write: (text: string) => void,
): Promise<string> {
  if (options.run !== undefined) {
    const summary = await client.attachSession(options.run);
    if (!isJsonMode()) write(`Attached to run ${summary.sessionId} (${summary.status}).\n`);
    return summary.sessionId;
  }
  return client.newSession(options.cwd !== undefined ? { cwd: options.cwd } : {});
}

/** Send one prompt and wait for the turn to stop, printing its stop reason. */
async function runTurn(
  client: ShimConnection['client'],
  sessionId: string,
  prompt: string,
  write: (text: string) => void,
): Promise<void> {
  if (!isJsonMode()) write('agent> ');
  const result = await client.prompt(sessionId, textBlocks(prompt));
  if (isJsonMode()) {
    emitEvent('chat.turn', { sessionId, stopReason: result.stopReason });
  } else {
    write(`\n[turn ended: ${result.stopReason}]\n`);
  }
}

/** List the shim's runs for a sandbox (used by `racecar chat --list`). */
export async function listShimRuns(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<readonly SessionSummary[]> {
  const connection = await connectShim(provider, sandboxId);
  try {
    await connection.client.initialize();
    return await connection.client.listSessions();
  } finally {
    connection.close();
    await connection.closed.catch(() => {});
  }
}
