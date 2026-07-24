import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RunAgentServer,
  RunRegistry,
  ShimServer,
  type Agent,
  type PermissionOption,
  type RequestPermissionRequest,
} from '@racecar/shim';
import { FakeSandboxProvider, type FakeExecHandler } from '@racecar/core/testing';
import type { PreviewUrl } from '@racecar/core';
import {
  chatWithSandbox,
  formatPermission,
  renderChatUpdate,
  resolvePermissionChoice,
} from './chat.js';

const OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

describe('renderChatUpdate', () => {
  it('streams agent text inline and labels tool calls on their own line', () => {
    expect(
      renderChatUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toEqual({ text: 'hi', newline: false });
    expect(
      renderChatUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 't',
        title: 'read',
        status: 'pending',
      }),
    ).toEqual({ text: '\n[tool pending] read', newline: true });
  });
});

describe('formatPermission', () => {
  it('lists each option with a 1-based index', () => {
    const request: RequestPermissionRequest = {
      sessionId: 's',
      toolCall: { toolCallId: 't', title: 'delete files' },
      options: OPTIONS,
    };
    const { lines, options } = formatPermission(request);
    expect(lines[0]).toContain('delete files');
    expect(lines.some((l) => l.includes('1) Allow'))).toBe(true);
    expect(lines.some((l) => l.includes('2) Reject'))).toBe(true);
    expect(options).toEqual(OPTIONS);
  });
});

describe('resolvePermissionChoice', () => {
  it('selects by index, by name, and defaults empty to the first option', () => {
    expect(resolvePermissionChoice('1', OPTIONS)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
    expect(resolvePermissionChoice('reject', OPTIONS)).toEqual({
      outcome: { outcome: 'selected', optionId: 'reject' },
    });
    expect(resolvePermissionChoice('', OPTIONS)).toEqual({
      outcome: { outcome: 'selected', optionId: 'allow' },
    });
  });

  it('cancels on an unrecognized answer', () => {
    expect(resolvePermissionChoice('nonsense', OPTIONS)).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });
});

// --- integration: the CLI's permission prompt end-to-end through the shim ---

const TOKEN = 'chat-test-token';

class ShimBackedProvider extends FakeSandboxProvider {
  readonly #url: string;
  constructor(url: string, execHandler: FakeExecHandler) {
    super({ execHandler });
    this.#url = url;
  }
  override getPreviewUrl(): Promise<PreviewUrl> {
    return Promise.resolve({ url: this.#url });
  }
}

const tokenExec: FakeExecHandler = (_id, request) =>
  request.command.includes('RACECAR_SHIM_TOKEN')
    ? { exitCode: 0, output: TOKEN }
    : { exitCode: 0, output: '' };

/** An agent that asks permission each turn, then reports the chosen option. */
const permissionAgent: Agent = {
  capabilities: {},
  newSession: (client) => ({
    id: 'perm',
    prompt: async () => {
      const answer = await client.requestPermission({
        toolCall: { toolCallId: 'c1', title: 'run a dangerous command' },
        options: OPTIONS,
      });
      client.sessionUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: {
          type: 'text',
          text:
            answer.outcome.outcome === 'selected'
              ? `decision: ${answer.outcome.optionId}`
              : 'declined',
        },
      });
      return { stopReason: 'end_turn' };
    },
    cancel: () => {},
    close: () => {},
  }),
};

let servers: ShimServer[] = [];
afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

describe('chatWithSandbox permission prompt', () => {
  it('prompts the operator and applies their choice', async () => {
    const registry = new RunRegistry({ agent: permissionAgent });
    const server = new ShimServer({
      token: TOKEN,
      port: 0,
      host: '127.0.0.1',
      connect: (peer) => new RunAgentServer(peer, registry),
    });
    servers.push(server);
    const { port } = await server.listen();
    const provider = new ShimBackedProvider(`http://127.0.0.1:${port}`, tokenExec);
    await provider.buildSnapshot({ name: 'snap', baseImage: 'node:24' });
    const id = (await provider.createSandbox({ snapshot: 'snap' })).id;

    // The operator answers the permission prompt with option 1 (Allow) — but only
    // once the prompt has been shown, mirroring a real terminal (an eagerly
    // pre-loaded stream would be consumed by readline before the question is asked).
    const input = new PassThrough();
    let answered = false;
    let output = '';
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb): void {
        output += chunk.toString('utf8');
        if (!answered && output.includes('Choose an option')) {
          answered = true;
          input.write('1\n');
        }
        cb();
      },
    });

    await chatWithSandbox(provider, id, { prompt: 'rm -rf /', input, output: sink });
    expect(output).toContain('decision: allow');
    expect(output).toContain('[turn ended: end_turn]');
  });
});
