import { describe, expect, it } from 'vitest';
import { FakeSandboxProvider, type FakeExecHandler } from '@racecar/core/testing';
import { listRuns, RunBusyError, startRun } from './run.js';

const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');

/** A record blob in the read-back protocol {@link parseRunRecords} expects. */
function runBlock(fields: {
  id: string;
  meta: { startedAt: string } & Record<string, unknown>;
  status: string;
  exit?: string;
  ended?: string;
  gitstatus?: string;
  gitdiff?: string;
}): string {
  return [
    '==RUN==',
    `id:${fields.id}`,
    `meta:${b64(JSON.stringify(fields.meta))}`,
    `started:${fields.meta.startedAt}`,
    `status:${fields.status}`,
    `exit:${fields.exit ?? ''}`,
    `ended:${fields.ended ?? ''}`,
    `gitstatus:${b64(fields.gitstatus ?? '')}`,
    `gitdiff:${b64(fields.gitdiff ?? '')}`,
    '',
  ].join('\n');
}

async function seed(provider: FakeSandboxProvider): Promise<string> {
  await provider.buildSnapshot({ name: 'snap', baseImage: 'node:22' });
  const sandbox = await provider.createSandbox({ snapshot: 'snap' });
  return sandbox.id;
}

/** Classify a script by a distinctive substring so a handler can respond to it. */
function kind(command: string): 'read' | 'status' | 'lock' | 'launch' | 'other' {
  if (command.includes('==RUN==')) return 'read';
  if (command.startsWith('cat') && command.includes('.status')) return 'status';
  if (command.includes('mkdir') && command.includes('run.lock.d')) return 'lock';
  if (command.includes('send-keys')) return 'launch';
  return 'other';
}

describe('startRun', () => {
  it('acquires the lock and launches the agent detached, returning the run id', async () => {
    const commands: string[] = [];
    const handler: FakeExecHandler = (_id, request) => {
      commands.push(request.command);
      if (kind(request.command) === 'lock') return { exitCode: 0, output: 'ACQUIRED\n' };
      return { exitCode: 0, output: '' };
    };
    const provider = new FakeSandboxProvider({ execHandler: handler });
    const id = await seed(provider);

    const result = await startRun(provider, id, 'do the thing', {
      workspaceDir: '/home/daytona/workspace',
    });

    expect(result.meta.id).toMatch(/^run-/);
    expect(result.meta.agent).toBe('claude-code');
    expect(result.record).toBeUndefined();
    // The lock was claimed and a run launched inside tmux.
    expect(commands.some((c) => kind(c) === 'lock')).toBe(true);
    expect(commands.some((c) => kind(c) === 'launch')).toBe(true);
  });

  it('refuses to start when another run holds the lock', async () => {
    const provider = new FakeSandboxProvider({
      execHandler: (_id, request) =>
        kind(request.command) === 'lock'
          ? { exitCode: 0, output: 'BUSY:run-existing\n' }
          : { exitCode: 0, output: '' },
    });
    const id = await seed(provider);

    await expect(startRun(provider, id, 'prompt', { workspaceDir: '/w' })).rejects.toBeInstanceOf(
      RunBusyError,
    );
  });

  it('starts a stopped sandbox before running', async () => {
    const provider = new FakeSandboxProvider({
      execHandler: (_id, request) =>
        kind(request.command) === 'lock'
          ? { exitCode: 0, output: 'ACQUIRED\n' }
          : { exitCode: 0, output: '' },
    });
    const id = await seed(provider);
    await provider.stopSandbox(id);

    await startRun(provider, id, 'prompt', { workspaceDir: '/w' });
    expect((await provider.getSandbox(id))?.state).toBe('started');
  });

  it('waits for a run to finish and returns its recorded result', async () => {
    const statuses = ['running', 'running', 'succeeded'];
    let polls = 0;
    const provider = new FakeSandboxProvider({
      execHandler: (_id, request) => {
        switch (kind(request.command)) {
          case 'lock':
            return { exitCode: 0, output: 'ACQUIRED\n' };
          case 'status':
            return { exitCode: 0, output: `${statuses[Math.min(polls++, statuses.length - 1)]}\n` };
          case 'read':
            return {
              exitCode: 0,
              output: runBlock({
                id: 'run-fixed',
                meta: {
                  id: 'run-fixed',
                  sandboxId: 's',
                  agent: 'claude-code',
                  prompt: 'p',
                  startedAt: '2026-07-10T00:00:00Z',
                },
                status: 'succeeded',
                exit: '0',
                ended: '2026-07-10T00:01:00Z',
                gitstatus: ' M a.ts',
                gitdiff: ' a.ts | 1 +',
              }),
            };
          default:
            return { exitCode: 0, output: '' };
        }
      },
    });
    const id = await seed(provider);

    const result = await startRun(provider, id, 'prompt', {
      workspaceDir: '/w',
      wait: true,
      pollMs: 1,
    });

    expect(result.timedOut).toBeUndefined();
    expect(result.record?.status).toBe('succeeded');
    expect(result.record?.exitCode).toBe(0);
    expect(result.record?.gitDiffStat).toContain('a.ts');
  });

  it('reports a timeout when a run does not finish in time', async () => {
    const provider = new FakeSandboxProvider({
      execHandler: (_id, request) =>
        kind(request.command) === 'lock'
          ? { exitCode: 0, output: 'ACQUIRED\n' }
          : kind(request.command) === 'status'
            ? { exitCode: 0, output: 'running\n' }
            : { exitCode: 0, output: '' },
    });
    const id = await seed(provider);

    const result = await startRun(provider, id, 'prompt', {
      workspaceDir: '/w',
      wait: true,
      pollMs: 1,
      waitTimeoutSeconds: 0,
    });
    expect(result.timedOut).toBe(true);
    expect(result.record).toBeUndefined();
  });
});

describe('listRuns', () => {
  it('parses recorded runs from a started sandbox', async () => {
    const provider = new FakeSandboxProvider({
      execHandler: (_id, request) =>
        kind(request.command) === 'read'
          ? {
              exitCode: 0,
              output: runBlock({
                id: 'run-1',
                meta: {
                  id: 'run-1',
                  sandboxId: 's',
                  agent: 'claude-code',
                  prompt: 'p',
                  startedAt: '2026-07-10T00:00:00Z',
                },
                status: 'failed',
                exit: '2',
                ended: '2026-07-10T00:02:00Z',
              }),
            }
          : { exitCode: 0, output: '' },
    });
    const id = await seed(provider);

    const records = await listRuns(provider, id);
    expect(records).toHaveLength(1);
    expect(records[0]?.status).toBe('failed');
    expect(records[0]?.exitCode).toBe(2);
  });

  it('returns nothing for a stopped sandbox', async () => {
    const provider = new FakeSandboxProvider();
    const id = await seed(provider);
    await provider.stopSandbox(id);
    expect(await listRuns(provider, id)).toEqual([]);
  });
});
