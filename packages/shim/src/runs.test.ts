import { describe, expect, it, vi } from 'vitest';
import type { RequestPermissionResponse, SessionUpdate } from './acp.js';
import { EchoAgent, type Agent, type AgentSession, type SessionClient } from './agent.js';
import { RunRegistry, type GitSummary, type PermissionResponder } from './runs.js';

/** A responder that always selects `optionId`. */
function allow(optionId: string): PermissionResponder {
  return {
    requestPermission: (): Promise<RequestPermissionResponse> =>
      Promise.resolve({ outcome: { outcome: 'selected', optionId } }),
  };
}

describe('RunRegistry with the echo agent', () => {
  it('creates a run, streams the echo, and ends the turn', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const run = await registry.createRun({});
    const updates: SessionUpdate[] = [];
    run.observe((u) => updates.push(u));
    const result = await run.prompt([{ type: 'text', text: 'hello' }], allow('allow'));
    expect(result.stopReason).toBe('end_turn');
    expect(updates).toEqual([
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'echo: hello' } },
    ]);
  });

  it('replays the transcript to a late observer, then streams live', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const run = await registry.createRun({});
    await run.prompt([{ type: 'text', text: 'first' }], allow('allow'));

    // A second observer joining after the first turn sees it replayed.
    const late: SessionUpdate[] = [];
    run.observe((u) => late.push(u));
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ content: { type: 'text', text: 'echo: first' } });

    await run.prompt([{ type: 'text', text: 'second' }], allow('allow'));
    expect(late).toHaveLength(2);
    expect(late[1]).toMatchObject({ content: { type: 'text', text: 'echo: second' } });
  });

  it('lists runs with a title derived from the first prompt', async () => {
    const registry = new RunRegistry({ agent: new EchoAgent() });
    const run = await registry.createRun({});
    await run.prompt([{ type: 'text', text: 'fix the parser bug' }], allow('allow'));
    const [summary] = registry.list();
    expect(summary?.sessionId).toBe(run.id);
    expect(summary?.title).toBe('fix the parser bug');
    expect(summary?.status).toBe('idle');
    expect(summary?.lastStopReason).toBe('end_turn');
  });

  it('captures a git summary at turn end', async () => {
    const summary: GitSummary = { gitStatus: ' M a.ts', gitDiffStat: ' a.ts | 2 +-' };
    const captureGit = vi.fn().mockResolvedValue(summary);
    const registry = new RunRegistry({ agent: new EchoAgent(), captureGit });
    const run = await registry.createRun({ cwd: '/workspace' });
    await run.prompt([{ type: 'text', text: 'go' }], allow('allow'));
    expect(captureGit).toHaveBeenCalledWith('/workspace');
    expect(run.summary().gitStatus).toBe(' M a.ts');
    expect(run.summary().gitDiffStat).toBe(' a.ts | 2 +-');
  });

  it('emits every update to the transcript sink with the run id', async () => {
    const seen: { runId: string; text: string }[] = [];
    const registry = new RunRegistry({
      agent: new EchoAgent(),
      onTranscript: (runId, update) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          seen.push({ runId, text: update.content.text });
        }
      },
    });
    const run = await registry.createRun({});
    await run.prompt([{ type: 'text', text: 'mirror me' }], allow('allow'));
    expect(seen).toEqual([{ runId: run.id, text: 'echo: mirror me' }]);
  });
});

describe('RunRegistry permission routing', () => {
  // An agent whose session asks for permission during a turn, so we can assert the
  // request is routed to the responder that owns the turn.
  class PermissionAgent implements Agent {
    readonly capabilities = {};
    newSession(client: SessionClient): AgentSession {
      return {
        id: 'perm-1',
        prompt: async () => {
          const answer = await client.requestPermission({
            toolCall: { toolCallId: 'c1', title: 'do it' },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
          });
          client.sessionUpdate({
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                answer.outcome.outcome === 'selected'
                  ? `chose ${answer.outcome.optionId}`
                  : 'cancelled',
            },
          });
          return { stopReason: 'end_turn' };
        },
        cancel: () => {},
        close: () => {},
      };
    }
  }

  it('routes a permission request to the turn owner', async () => {
    const registry = new RunRegistry({ agent: new PermissionAgent() });
    const run = await registry.createRun({});
    const updates: SessionUpdate[] = [];
    run.observe((u) => updates.push(u));
    await run.prompt([{ type: 'text', text: 'go' }], allow('allow'));
    expect(updates[0]).toMatchObject({ content: { type: 'text', text: 'chose allow' } });
  });
});
