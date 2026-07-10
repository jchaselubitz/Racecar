import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildCredentialInjection,
  claudeCredential,
  CLAUDE_OAUTH_ENV,
  CredentialDecryptError,
  CredentialStore,
  decryptCredentials,
  encryptCredentials,
  extractClaudeToken,
  gitCredential,
  GIT_CREDENTIALS_ENV,
  parseMasterKey,
  Redactor,
  secretFingerprint,
  type CredentialMap,
} from '../index.js';

const clock = () => new Date('2026-07-10T12:00:00.000Z');

describe('credential envelope', () => {
  it('round-trips a credential map under a 32-byte key', () => {
    const key = randomBytes(32);
    const map: CredentialMap = {
      claude: claudeCredential({ oauthToken: 'sk-ant-oat01-secret' }, clock),
    };
    const envelope = encryptCredentials(map, key);
    expect(envelope.data).not.toContain('sk-ant');
    expect(decryptCredentials(envelope, key)).toEqual(map);
  });

  it('fails to decrypt under the wrong key', () => {
    const envelope = encryptCredentials(
      { claude: claudeCredential({ oauthToken: 'sk-ant-oat01-secret' }, clock) },
      randomBytes(32),
    );
    expect(() => decryptCredentials(envelope, randomBytes(32))).toThrow(CredentialDecryptError);
  });

  it('parses base64 and hex master keys and rejects wrong sizes', () => {
    const key = randomBytes(32);
    expect(parseMasterKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseMasterKey(key.toString('hex')).equals(key)).toBe(true);
    expect(() => parseMasterKey('too-short')).toThrow();
  });
});

describe('CredentialStore', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'racecar-cred-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('generates a 0600 key, persists, and reloads across instances', async () => {
    const store = new CredentialStore({ dir });
    await store.set('claude', claudeCredential({ oauthToken: 'sk-ant-oat01-abc' }, clock));

    const keyStat = await stat(join(dir, 'master.key'));
    expect(keyStat.mode & 0o777).toBe(0o600);
    const storeStat = await stat(join(dir, 'credentials.enc'));
    expect(storeStat.mode & 0o777).toBe(0o600);
    // The encrypted file must not contain the secret in the clear.
    expect(await readFile(join(dir, 'credentials.enc'), 'utf8')).not.toContain('sk-ant');

    const reopened = new CredentialStore({ dir });
    expect((await reopened.get('claude'))?.secrets['oauthToken']).toBe('sk-ant-oat01-abc');
  });

  it('lists, removes, and collects secrets for redaction', async () => {
    const store = new CredentialStore({ dir });
    await store.set('claude', claudeCredential({ oauthToken: 'sk-ant-oat01-abc' }, clock));
    await store.set('git', gitCredential({ token: 'ghp_tokenvalue' }, clock));

    expect((await store.names()).sort()).toEqual(['claude', 'git']);
    expect((await store.secrets()).sort()).toEqual(['ghp_tokenvalue', 'sk-ant-oat01-abc']);

    expect(await store.remove('git')).toBe(true);
    expect(await store.remove('git')).toBe(false);
    expect(await store.names()).toEqual(['claude']);
  });

  it('returns no secrets when the store does not exist', async () => {
    expect(await new CredentialStore({ dir }).secrets()).toEqual([]);
  });
});

describe('buildCredentialInjection', () => {
  it('maps a Claude token to its env var and no commands', () => {
    const injection = buildCredentialInjection({
      claude: claudeCredential({ oauthToken: 'sk-ant-oat01-abc' }, clock),
    });
    expect(injection.env[CLAUDE_OAUTH_ENV]).toBe('sk-ant-oat01-abc');
    expect(injection.setupCommands).toEqual([]);
  });

  it('maps git credentials to an env var plus 0600 materializer commands', () => {
    const injection = buildCredentialInjection({
      git: gitCredential(
        { token: 'ghp_tokenvalue', host: 'github.com', username: 'x-access-token' },
        clock,
      ),
    });
    expect(injection.env[GIT_CREDENTIALS_ENV]).toBe(
      'https://x-access-token:ghp_tokenvalue@github.com',
    );
    // No secret literal in any setup command; only the env var name is referenced.
    const joined = injection.setupCommands.join('\n');
    expect(joined).toContain(`"$${GIT_CREDENTIALS_ENV}"`);
    expect(joined).toContain('chmod 600 "$HOME/.git-credentials"');
    expect(joined).not.toContain('ghp_tokenvalue');
  });
});

describe('Redactor', () => {
  it('masks known secrets, longest first, and ignores trivially short values', () => {
    const redactor = new Redactor(['sk-ant-oat01-abc', 'sk-ant-oat01-abc-extra', 'no']);
    expect(redactor.size).toBe(2);
    const masked = redactor.redact('token=sk-ant-oat01-abc-extra tail no');
    expect(masked).not.toContain('sk-ant');
    expect(masked).toContain('no'); // short value left intact
  });

  it('is a no-op when there are no secrets', () => {
    expect(new Redactor([]).redact('nothing secret here')).toBe('nothing secret here');
  });
});

describe('extractClaudeToken', () => {
  it('extracts the last token-shaped string from noisy output', () => {
    const output =
      'Visit https://claude.ai to authorize\nToken: sk-ant-oat01-REALtoken0123456789\n';
    expect(extractClaudeToken(output)).toBe('sk-ant-oat01-REALtoken0123456789');
  });

  it('returns undefined when no token is present', () => {
    expect(extractClaudeToken('no token here')).toBeUndefined();
  });
});

describe('secretFingerprint', () => {
  it('is stable, short, and non-reversible', () => {
    const print = secretFingerprint('sk-ant-oat01-abc');
    expect(print).toHaveLength(8);
    expect(print).toBe(secretFingerprint('sk-ant-oat01-abc'));
    expect(print).not.toContain('sk-ant');
  });
});
