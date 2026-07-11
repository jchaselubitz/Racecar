import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PromptResponse, SessionUpdate } from './acp.js';
import type { SessionClient } from './agent.js';
import { spawnAgentProcess, type AgentProcess, type ExitInfo } from './stdio.js';
import { StreamJsonAgent } from './stream-json.js';

/**
 * A scripted in-memory stream-json process. `respond` turns each written `user`
 * envelope into a sequence of emitted stdout events, so the bridge is testable
 * with no subprocess. Not emitting a `result` leaves the turn in flight (for the
 * cancel test); `kill` reports an exit.
 */
function fakeStreamJsonProcess(
  respond: (userText: string, emit: (event: unknown) => void) => void,
): AgentProcess {
  const lineHandlers: ((line: string) => void)[] = [];
  const exitHandlers: ((info: ExitInfo) => void)[] = [];
  const emit = (event: unknown): void => {
    for (const handler of lineHandlers) handler(JSON.stringify(event));
  };
  return {
    writeLine: (line) => {
      const msg = JSON.parse(line) as {
        type?: string;
        message?: { content?: { text?: string }[] };
      };
      if (msg.type !== 'user') return;
      const text = (msg.message?.content ?? []).map((b) => b.text ?? '').join('');
      queueMicrotask(() => respond(text, emit));
    },
    onLine: (handler) => lineHandlers.push(handler),
    onStderr: () => {},
    onExit: (handler) => exitHandlers.push(handler),
    kill: () => {
      for (const handler of exitHandlers) handler({ code: 0, signal: null });
    },
  };
}

/** A capturing {@link SessionClient}. */
function recordingClient(): { client: SessionClient; updates: SessionUpdate[] } {
  const updates: SessionUpdate[] = [];
  return {
    updates,
    client: {
      sessionUpdate: (u) => updates.push(u),
      requestPermission: () => Promise.resolve({ outcome: { outcome: 'cancelled' } }),
    },
  };
}

const echoOnce = (text: string, emit: (event: unknown) => void): void => {
  emit({ type: 'assistant', message: { content: [{ type: 'text', text: `echo: ${text}` }] } });
  emit({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${text}` });
};

describe('StreamJsonAgent (tier-2 bridge)', () => {
  it('advertises static text-only capabilities, matching the tier-1 shape', () => {
    const agent = new StreamJsonAgent(() => fakeStreamJsonProcess(echoOnce));
    expect(agent.capabilities).toEqual({
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
    });
  });

  it('bridges a prompt into a streamed chunk and end_turn', async () => {
    const agent = new StreamJsonAgent(() => fakeStreamJsonProcess(echoOnce));
    const { client, updates } = recordingClient();
    const session = agent.newSession(client);
    const result = await session.prompt([{ type: 'text', text: 'hello' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: hello' } },
    ]);
  });

  it('maps an error result to a refusal stop reason', async () => {
    const agent = new StreamJsonAgent(() =>
      fakeStreamJsonProcess((_text, emit) => {
        emit({ type: 'result', subtype: 'error', is_error: true, result: 'nope' });
      }),
    );
    const { client } = recordingClient();
    const session = agent.newSession(client);
    const result = await session.prompt([{ type: 'text', text: 'x' }]);
    expect(result.stopReason).toBe('refusal');
  });

  it('cancel resolves the in-flight turn as cancelled and stops forwarding output', async () => {
    let emitLater: ((event: unknown) => void) | undefined;
    const agent = new StreamJsonAgent(() =>
      fakeStreamJsonProcess((_text, emit) => {
        emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } });
        emitLater = emit; // Withhold the result so the turn stays in flight.
      }),
    );
    const { client, updates } = recordingClient();
    const session = agent.newSession(client);
    const pending = session.prompt([{ type: 'text', text: 'x' }]);
    await Promise.resolve(); // Let the assistant chunk arrive.
    session.cancel();
    const result = await pending;
    expect(result.stopReason).toBe('cancelled');
    // A late chunk after cancel is not forwarded.
    emitLater?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'late' }] } });
    expect(
      updates.map((u) => (u.sessionUpdate === 'agent_message_chunk' ? u.content.text : '')),
    ).toEqual(['partial']);
  });

  it('injects a mid-run user message onto the live subprocess, only during a turn', async () => {
    // A process that records every written envelope and withholds its result, so a
    // turn stays in flight while we inject.
    type UserEnvelope = { type?: string; message?: { content?: { text?: string }[] } };
    const writes: UserEnvelope[] = [];
    const lineHandlers: ((line: string) => void)[] = [];
    const proc: AgentProcess = {
      writeLine: (line) => writes.push(JSON.parse(line) as UserEnvelope),
      onLine: (h) => lineHandlers.push(h),
      onStderr: () => {},
      onExit: () => {},
      kill: () => {},
    };
    const agent = new StreamJsonAgent(() => proc);
    const { client } = recordingClient();
    const session = agent.newSession(client);

    // No turn in flight yet: injection is refused so the caller queues instead.
    expect(session.inject?.([{ type: 'text', text: 'early' }])).toBe(false);
    expect(writes).toHaveLength(0);

    const turn = session.prompt([{ type: 'text', text: 'go' }]);
    expect(session.inject?.([{ type: 'text', text: 'also this' }])).toBe(true);
    expect(writes.map((w) => w.message?.content?.[0]?.text)).toEqual(['go', 'also this']);
    expect(writes.every((w) => w.type === 'user')).toBe(true);

    for (const handler of lineHandlers) handler(JSON.stringify({ type: 'result', is_error: false }));
    expect((await turn).stopReason).toBe('end_turn');
  });

  it('resolves an in-flight turn if the process exits', async () => {
    const proc = fakeStreamJsonProcess(() => {
      /* never responds */
    });
    const agent = new StreamJsonAgent(() => proc);
    const { client } = recordingClient();
    const session = agent.newSession(client);
    const pending = session.prompt([{ type: 'text', text: 'x' }]);
    proc.kill();
    const result: PromptResponse = await pending;
    expect(result.stopReason).toBe('cancelled');
  });
});

describe('StreamJsonAgent over a real subprocess', () => {
  const fixture = fileURLToPath(new URL('../test-fixtures/stream-json-agent.mjs', import.meta.url));

  it('bridges a spawned stream-json agent end-to-end', async () => {
    const agent = new StreamJsonAgent(() =>
      spawnAgentProcess({ command: process.execPath, args: [fixture] }),
    );
    const { client, updates } = recordingClient();
    const session = agent.newSession(client);
    const result = await session.prompt([{ type: 'text', text: 'hi' }]);
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toContainEqual({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'echo: hi' },
    });
    const boom = await session.prompt([{ type: 'text', text: 'BOOM' }]);
    expect(boom.stopReason).toBe('refusal');
    session.close();
  });
});
