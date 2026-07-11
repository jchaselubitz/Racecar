import { afterEach, describe, expect, it } from 'vitest';
import { EchoAgent, RunAgentServer, RunRegistry, ShimServer, type CaptureGit } from '@racecar/shim';
import { FakeSandboxProvider, type FakeExecHandler } from '@racecar/core/testing';
import type { PreviewUrl } from '@racecar/core';
import { listRuns, startRun, statusFromStopReason } from './run.js';

const TOKEN = 'run-test-token';

/** A fake provider whose preview URL points at a real local shim server. */
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

/** Exec handler that serves the shim token and nothing else. */
const tokenExec: FakeExecHandler = (_id, request) =>
  request.command.includes('RACECAR_SHIM_TOKEN')
    ? { exitCode: 0, output: TOKEN }
    : { exitCode: 0, output: '' };

let servers: ShimServer[] = [];

afterEach(async () => {
  await Promise.all(servers.map((s) => s.close()));
  servers = [];
});

/** Start a shim server backed by a shared run registry (EchoAgent by default). */
async function startShim(captureGit?: CaptureGit): Promise<{ url: string }> {
  const registry = new RunRegistry({
    agent: new EchoAgent(),
    ...(captureGit ? { captureGit } : {}),
  });
  const server = new ShimServer({
    token: TOKEN,
    port: 0,
    host: '127.0.0.1',
    connect: (peer) => new RunAgentServer(peer, registry),
  });
  servers.push(server);
  const { port } = await server.listen();
  return { url: `http://127.0.0.1:${port}` };
}

async function seed(provider: FakeSandboxProvider): Promise<string> {
  await provider.buildSnapshot({ name: 'snap', baseImage: 'node:22' });
  return (await provider.createSandbox({ snapshot: 'snap' })).id;
}

describe('statusFromStopReason', () => {
  it('maps stop reasons to run statuses', () => {
    expect(statusFromStopReason('end_turn')).toBe('succeeded');
    expect(statusFromStopReason('max_tokens')).toBe('succeeded');
    expect(statusFromStopReason('refusal')).toBe('failed');
    expect(statusFromStopReason('cancelled')).toBe('cancelled');
  });
});

describe('startRun through the shim', () => {
  it('creates a run, streams the reply, and records the result', async () => {
    const { url } = await startShim();
    const provider = new ShimBackedProvider(url, tokenExec);
    const id = await seed(provider);

    const updates: string[] = [];
    const result = await startRun(provider, id, 'do the thing', {
      workspaceDir: '/workspace',
      onUpdate: (update) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          updates.push(update.content.text);
        }
      },
    });

    expect(result.timedOut).toBeUndefined();
    expect(result.record.runId).toMatch(/^run-/);
    expect(result.record.status).toBe('succeeded');
    expect(result.record.stopReason).toBe('end_turn');
    expect(updates).toEqual(['echo: do the thing']);
  });

  it('records the git summary the shim captured at turn end', async () => {
    const captureGit: CaptureGit = () =>
      Promise.resolve({ gitStatus: ' M x.ts', gitDiffStat: ' x.ts | 3 +' });
    const { url } = await startShim(captureGit);
    const provider = new ShimBackedProvider(url, tokenExec);
    const id = await seed(provider);

    const result = await startRun(provider, id, 'edit x', { workspaceDir: '/workspace' });
    expect(result.record.gitStatus).toBe(' M x.ts');
    expect(result.record.gitDiffStat).toBe(' x.ts | 3 +');
  });

  it('starts a stopped sandbox before running', async () => {
    const { url } = await startShim();
    const provider = new ShimBackedProvider(url, tokenExec);
    const id = await seed(provider);
    await provider.stopSandbox(id);

    await startRun(provider, id, 'go', { workspaceDir: '/w' });
    expect((await provider.getSandbox(id))?.state).toBe('started');
  });

  it('reports a timeout while leaving the run in the shim', async () => {
    // A registry whose agent never resolves a turn, so the wait times out.
    const registry = new RunRegistry({
      agent: {
        capabilities: {},
        newSession: () => ({
          id: 'hang',
          prompt: () => new Promise(() => {}),
          cancel: () => {},
          close: () => {},
        }),
      },
    });
    const server = new ShimServer({
      token: TOKEN,
      port: 0,
      host: '127.0.0.1',
      connect: (peer) => new RunAgentServer(peer, registry),
    });
    servers.push(server);
    const { port } = await server.listen();
    const provider = new ShimBackedProvider(`http://127.0.0.1:${port}`, tokenExec);
    const id = await seed(provider);

    const result = await startRun(provider, id, 'go', {
      workspaceDir: '/w',
      waitTimeoutSeconds: 0,
    });
    expect(result.timedOut).toBe(true);
    expect(result.record.status).toBe('running');
  });
});

describe('listRuns through the shim', () => {
  it('lists recorded runs from a started sandbox', async () => {
    const { url } = await startShim();
    const provider = new ShimBackedProvider(url, tokenExec);
    const id = await seed(provider);
    await startRun(provider, id, 'first task', { workspaceDir: '/w' });

    const records = await listRuns(provider, id);
    expect(records).toHaveLength(1);
    expect(records[0]?.title).toBe('first task');
    expect(records[0]?.status).toBe('succeeded');
  });

  it('returns nothing for a stopped sandbox', async () => {
    const { url } = await startShim();
    const provider = new ShimBackedProvider(url, tokenExec);
    const id = await seed(provider);
    await provider.stopSandbox(id);
    expect(await listRuns(provider, id)).toEqual([]);
  });
});
