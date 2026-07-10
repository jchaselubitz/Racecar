import { describe, expect, it } from 'vitest';
import {
  acquireLockScript,
  generateRunId,
  knownAgents,
  launchRunScript,
  parseLockResult,
  parseRunRecords,
  readRunsScript,
  resolveAgent,
  runStatusScript,
  type RunMeta,
} from './index.js';

describe('generateRunId', () => {
  it('produces a filename- and shell-safe, chronologically sortable id', () => {
    const early = generateRunId(
      () => new Date('2026-01-01T00:00:00Z'),
      () => 0.1,
    );
    const late = generateRunId(
      () => new Date('2026-06-01T00:00:00Z'),
      () => 0.9,
    );
    expect(early).toMatch(/^run-[0-9a-z]+-[0-9a-z]{6}$/);
    expect(early < late).toBe(true);
  });
});

describe('resolveAgent', () => {
  it('resolves claude-code and rejects unknown agents', () => {
    expect(resolveAgent('claude-code').command).toContain('claude');
    expect(knownAgents()).toContain('claude-code');
    expect(() => resolveAgent('nope')).toThrow(/unknown agent/);
  });
});

describe('acquireLockScript / parseLockResult', () => {
  it('round-trips an acquired lock', () => {
    expect(acquireLockScript('run-1')).toContain('mkdir "$HOME/.racecar/run.lock.d"');
    expect(parseLockResult('ACQUIRED\n')).toEqual({ acquired: true });
  });

  it('parses a busy lock and its holder', () => {
    expect(parseLockResult('BUSY:run-abc\n')).toEqual({ acquired: false, activeRunId: 'run-abc' });
  });

  it('treats unrecognized output as busy rather than launching concurrently', () => {
    expect(parseLockResult('garbage')).toEqual({ acquired: false, activeRunId: '' });
  });

  it('clears a stale lock only when forced', () => {
    expect(acquireLockScript('run-1', false)).not.toContain('rm -rf');
    expect(acquireLockScript('run-1', true)).toContain('rm -rf "$HOME/.racecar/run.lock.d"');
  });
});

describe('launchRunScript', () => {
  const meta: RunMeta = {
    id: 'run-xyz',
    sandboxId: 'sbx-1',
    agent: 'claude-code',
    prompt: "explain 'quoting' && rm -rf / # dangerous",
    startedAt: '2026-07-10T00:00:00Z',
  };
  const script = launchRunScript({
    meta,
    agent: resolveAgent('claude-code'),
    workspaceDir: '/home/daytona/workspace',
  });

  it('launches the wrapper detached inside the named tmux session', () => {
    expect(script).toContain("tmux send-keys -t 'racecar'");
    expect(script).toContain('base64 -d');
  });

  it('never puts the prompt literal into the command string', () => {
    expect(script).not.toContain('rm -rf /');
    expect(script).not.toContain('dangerous');
  });
});

describe('readRunsScript / parseRunRecords', () => {
  it('reconstructs records from the read-back protocol, newest last', () => {
    const meta1 = {
      id: 'run-a',
      sandboxId: 's',
      agent: 'claude-code',
      prompt: 'first',
      startedAt: '2026-01-01T00:00:00Z',
    };
    const meta2 = {
      id: 'run-b',
      sandboxId: 's',
      agent: 'claude-code',
      prompt: 'second',
      startedAt: '2026-02-01T00:00:00Z',
    };
    const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');
    const output = [
      '==RUN==',
      'id:run-b',
      `meta:${b64(JSON.stringify(meta2))}`,
      'started:2026-02-01T00:00:00Z',
      'status:running',
      'exit:',
      'ended:',
      'gitstatus:',
      'gitdiff:',
      '==RUN==',
      'id:run-a',
      `meta:${b64(JSON.stringify(meta1))}`,
      'started:2026-01-01T00:00:00Z',
      'status:succeeded',
      'exit:0',
      'ended:2026-01-01T00:05:00Z',
      `gitstatus:${b64(' M src/app.ts\n?? new.ts')}`,
      `gitdiff:${b64(' src/app.ts | 2 +-\n 1 file changed')}`,
      '',
    ].join('\n');

    const records = parseRunRecords(output);
    expect(records.map((r) => r.id)).toEqual(['run-a', 'run-b']);
    const done = records[0];
    expect(done?.status).toBe('succeeded');
    expect(done?.exitCode).toBe(0);
    expect(done?.gitStatus).toContain('?? new.ts');
    expect(done?.gitDiffStat).toContain('1 file changed');
    expect(records[1]?.status).toBe('running');
    expect(records[1]?.exitCode).toBeUndefined();
  });

  it('skips blocks with no decodable meta', () => {
    expect(parseRunRecords('==RUN==\nid:x\nmeta:\nstatus:running')).toEqual([]);
  });

  it('reads only the requested ids when given', () => {
    expect(readRunsScript(['run-a'])).toContain("printf '%s\\n' 'run-a'");
    expect(readRunsScript()).toContain('*.meta.json');
  });
});

describe('runStatusScript', () => {
  it('reads the run status file', () => {
    expect(runStatusScript('run-1')).toContain('.status');
    expect(runStatusScript('run-1')).toContain("'run-1'");
  });
});
