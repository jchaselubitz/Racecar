import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeCredential } from '@racecar/core';
import { openCredentialStore } from './credentials.js';
import { runSetup, type PromptFn, type SetupIo } from './setup.js';

// A fixed 32-byte key (hex) so the store is readable without touching a keyfile.
const MASTER_KEY = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';

describe('runSetup', () => {
  let home: string;
  let previousHome: string | undefined;
  let previousKey: string | undefined;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'racecar-setup-'));
    previousHome = process.env.RACECAR_HOME;
    previousKey = process.env.RACECAR_MASTER_KEY;
    process.env.RACECAR_HOME = home;
    process.env.RACECAR_MASTER_KEY = MASTER_KEY;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.RACECAR_HOME;
    else process.env.RACECAR_HOME = previousHome;
    if (previousKey === undefined) delete process.env.RACECAR_MASTER_KEY;
    else process.env.RACECAR_MASTER_KEY = previousKey;
    await rm(home, { recursive: true, force: true });
  });

  const makeIo = (env: NodeJS.ProcessEnv, prompt: PromptFn, lines: string[]): SetupIo => ({
    env,
    store: openCredentialStore(),
    prompt,
    write: (text) => lines.push(text),
    redact: () => {},
  });

  it('seeds both credentials from the environment without prompting', async () => {
    const prompt = vi.fn<PromptFn>();
    const lines: string[] = [];
    await runSetup(
      makeIo(
        {
          CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fromenv',
          GH_AUTH_TOKEN: 'ghp_fromenv',
          GH_USERNAME: 'octocat',
        },
        prompt,
        lines,
      ),
    );
    expect(prompt).not.toHaveBeenCalled();
    const map = await openCredentialStore().load();
    expect(map['claude']?.secrets['oauthToken']).toBe('sk-ant-oat01-fromenv');
    expect(map['git']?.secrets['token']).toBe('ghp_fromenv');
    expect(map['git']?.meta?.username).toBe('octocat');
    const output = lines.join('');
    expect(output).toContain('set from environment');
    expect(output).toContain('Stored credentials:');
  });

  it('prompts for missing credentials step by step', async () => {
    const answers = ['sk-ant-oat01-typed', 'ghp_typed', 'my-login'];
    const prompt: PromptFn = vi.fn(() => Promise.resolve(answers.shift() ?? ''));
    const lines: string[] = [];
    await runSetup(makeIo({}, prompt, lines));
    expect(prompt).toHaveBeenCalledTimes(3);
    const map = await openCredentialStore().load();
    expect(map['claude']?.secrets['oauthToken']).toBe('sk-ant-oat01-typed');
    expect(map['git']?.secrets['token']).toBe('ghp_typed');
    expect(map['git']?.meta?.username).toBe('my-login');
  });

  it('leaves an already-stored credential untouched and skips a blank prompt', async () => {
    await openCredentialStore().set('claude', claudeCredential({ oauthToken: 'sk-ant-oat01-old' }));
    // No env, blank git token → git is skipped; claude is kept as stored.
    const prompt: PromptFn = vi.fn(() => Promise.resolve(''));
    const lines: string[] = [];
    await runSetup(makeIo({}, prompt, lines));
    const map = await openCredentialStore().load();
    expect(map['claude']?.secrets['oauthToken']).toBe('sk-ant-oat01-old');
    expect(map['git']).toBeUndefined();
    const output = lines.join('');
    expect(output).toContain('already stored');
    expect(output).toContain('GitHub credential: skipped');
  });
});
