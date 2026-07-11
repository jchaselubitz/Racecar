import { describe, expect, it } from 'vitest';
import { ProcessAcpAgent } from './acp-client.js';
import { EchoAgent } from './agent.js';
import { buildAgentFactory, resolveAgentSelection } from './agents.js';
import { StreamJsonAgent } from './stream-json.js';
import type { AgentProcess, SpawnSpec } from './stdio.js';

/** An inert {@link AgentProcess} that records the spec it was spawned from. */
function inertProcess(): AgentProcess {
  return {
    writeLine: () => {},
    onLine: () => {},
    onStderr: () => {},
    onExit: () => {},
    kill: () => {},
  };
}

describe('resolveAgentSelection', () => {
  it('applies per-kind default commands', () => {
    expect(resolveAgentSelection('claude-code')).toEqual({
      kind: 'claude-code',
      command: 'claude-code-acp',
      args: [],
    });
    expect(resolveAgentSelection('stream-json').command).toBe('claude');
    expect(resolveAgentSelection('echo')).toEqual({ kind: 'echo', command: '', args: [] });
  });

  it('applies overrides over the defaults', () => {
    expect(resolveAgentSelection('codex', { command: 'npx', args: ['-y', 'x'] })).toEqual({
      kind: 'codex',
      command: 'npx',
      args: ['-y', 'x'],
    });
  });
});

describe('buildAgentFactory', () => {
  it('builds the in-process echo agent without spawning', () => {
    const specs: SpawnSpec[] = [];
    const factory = buildAgentFactory(resolveAgentSelection('echo'), (spec) => {
      specs.push(spec);
      return inertProcess();
    });
    expect(factory()).toBeInstanceOf(EchoAgent);
    expect(specs).toHaveLength(0);
  });

  it('spawns an ACP subprocess for a tier-1 kind with its resolved spec', () => {
    const specs: SpawnSpec[] = [];
    const factory = buildAgentFactory(resolveAgentSelection('codex'), (spec) => {
      specs.push(spec);
      return inertProcess();
    });
    expect(factory()).toBeInstanceOf(ProcessAcpAgent);
    expect(specs[0]).toMatchObject({ command: 'codex-acp', args: [] });
  });

  it('builds the stream-json bridge, spawning lazily per session', () => {
    const specs: SpawnSpec[] = [];
    const factory = buildAgentFactory(resolveAgentSelection('stream-json'), (spec) => {
      specs.push(spec);
      return inertProcess();
    });
    const agent = factory();
    expect(agent).toBeInstanceOf(StreamJsonAgent);
    // No process until the first session is created.
    expect(specs).toHaveLength(0);
    void agent.newSession(
      { sessionUpdate() {}, requestPermission: () => Promise.reject(new Error()) },
      {},
    );
    expect(specs).toHaveLength(1);
    expect(specs[0]?.command).toBe('claude');
  });
});
