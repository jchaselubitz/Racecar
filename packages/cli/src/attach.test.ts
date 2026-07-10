import { describe, expect, it } from 'vitest';
import { FakeSandboxProvider, type FakePty } from '@racecar/core/testing';
import { attachToSandbox } from './attach.js';

/** Wait until the fake provider has created at least `count` PTYs. */
async function waitForPty(provider: FakeSandboxProvider, count: number): Promise<FakePty> {
  for (let i = 0; i < 2000 && provider.ptys.length < count; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
  const pty = provider.ptys[count - 1];
  if (pty === undefined) throw new Error('PTY was never created');
  return pty;
}

async function seed(provider: FakeSandboxProvider): Promise<string> {
  await provider.buildSnapshot({ name: 'snap', baseImage: 'node:22' });
  const sandbox = await provider.createSandbox({ snapshot: 'snap' });
  return sandbox.id;
}

describe('attachToSandbox', () => {
  it('launches tmux in the PTY and returns on a clean detach', async () => {
    const provider = new FakeSandboxProvider();
    const id = await seed(provider);

    const attaching = attachToSandbox(provider, id, { startDir: '/workspace' });
    const pty = await waitForPty(provider, 1);
    // A clean detach: the tmux client exits with no error.
    pty.finish({ exitCode: 0 });
    await attaching;

    const sent = pty.inputs.map((chunk) => chunk.toString()).join('');
    expect(sent).toContain("exec tmux new-session -A -s 'racecar' -c '/workspace'");
    expect(pty.disconnected).toBe(true);
  });

  it('starts a stopped sandbox before attaching', async () => {
    const provider = new FakeSandboxProvider();
    const id = await seed(provider);
    await provider.stopSandbox(id);

    const attaching = attachToSandbox(provider, id);
    const pty = await waitForPty(provider, 1);
    pty.finish({ exitCode: 0 });
    await attaching;

    expect((await provider.getSandbox(id))?.state).toBe('started');
  });

  it('reconnects after a dropped connection, then detaches cleanly', async () => {
    const provider = new FakeSandboxProvider();
    const id = await seed(provider);

    const attaching = attachToSandbox(provider, id);
    const first = await waitForPty(provider, 1);
    // A dropped connection surfaces as an error, which triggers a reconnect.
    first.finish({ error: 'connection reset' });
    const second = await waitForPty(provider, 2);
    second.finish({ exitCode: 0 });
    await attaching;

    expect(provider.ptys).toHaveLength(2);
  });
});
