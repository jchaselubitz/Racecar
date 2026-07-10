/**
 * The local encrypted credential store.
 *
 * Racecar keeps agent credentials (a Claude OAuth token, git credentials) in a
 * machine-local store encrypted at rest with AES-256-GCM. The store is a single
 * JSON envelope file; a sibling key file holds the 32-byte master key. Both are
 * written `0600`. This is the "local encrypted store first" posture the
 * implementation plan commits to for v1 — a hosted secret manager is deferred.
 *
 * The crypto and envelope functions are pure and take an explicit key, so they
 * are exercised in tests without touching the real home directory. The
 * {@link CredentialStore} class binds them to a directory on disk.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** AES-256-GCM: a 256-bit key, a 96-bit IV, and a 128-bit auth tag. */
const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32;
const IV_BYTES = 12;
/** Envelope schema version, so the on-disk format can evolve. */
const ENVELOPE_VERSION = 1;

/** Filenames within the store directory. */
const KEY_FILE = 'master.key';
const CREDENTIALS_FILE = 'credentials.enc';

/**
 * A single stored credential. Secret field values live in {@link secrets} and
 * are redacted from all output and injected into sandboxes; non-secret display
 * metadata (a git host, a username) lives in {@link meta} and is safe to print.
 */
export interface StoredCredential {
  /** Credential kind, e.g. `"claude"` or `"git"`. Left open for future kinds. */
  readonly kind: string;
  /** ISO-8601 timestamp the credential was stored. */
  readonly createdAt: string;
  /** Secret values — never displayed, always redacted, injected as env vars. */
  readonly secrets: Record<string, string>;
  /** Non-secret metadata safe to display in `racecar auth list`. */
  readonly meta?: Record<string, string>;
}

/** The decrypted store: named credentials keyed by a stable name. */
export type CredentialMap = Record<string, StoredCredential>;

/** The on-disk encrypted envelope. All binary fields are base64. */
export interface EncryptedEnvelope {
  readonly v: number;
  readonly alg: string;
  readonly iv: string;
  readonly tag: string;
  readonly data: string;
}

/** Thrown when a master key value is not exactly 32 bytes. */
export class InvalidMasterKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMasterKeyError';
  }
}

/** Thrown when the store cannot be decrypted (wrong key or tampered file). */
export class CredentialDecryptError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialDecryptError';
  }
}

/** Encrypt a credential map into an {@link EncryptedEnvelope} under `key`. */
export function encryptCredentials(map: CredentialMap, key: Buffer): EncryptedEnvelope {
  assertKey(key);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(map), 'utf8');
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    alg: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

/** Decrypt an {@link EncryptedEnvelope} back into a credential map. */
export function decryptCredentials(envelope: EncryptedEnvelope, key: Buffer): CredentialMap {
  assertKey(key);
  if (envelope.alg !== ALGORITHM) {
    throw new CredentialDecryptError(`unsupported credential encryption '${envelope.alg}'`);
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString('utf8')) as CredentialMap;
  } catch (error) {
    throw new CredentialDecryptError(
      'could not decrypt credential store (wrong master key or corrupt file)',
      { cause: error },
    );
  }
}

/** Parse a master key supplied as base64 or hex; must decode to 32 bytes. */
export function parseMasterKey(value: string): Buffer {
  const trimmed = value.trim();
  const candidates: Buffer[] = [];
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) candidates.push(Buffer.from(trimmed, 'hex'));
  candidates.push(Buffer.from(trimmed, 'base64'));
  for (const candidate of candidates) {
    if (candidate.length === KEY_BYTES) return candidate;
  }
  throw new InvalidMasterKeyError('master key must decode to 32 bytes (base64 or hex)');
}

function assertKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new InvalidMasterKeyError(`master key must be ${KEY_BYTES} bytes, got ${key.length}`);
  }
}

async function writeFilePrivate(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
  await chmod(path, 0o600);
}

async function readFileMaybe(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Options for {@link CredentialStore}. */
export interface CredentialStoreOptions {
  /** Directory holding the key and encrypted store (e.g. `~/.racecar`). */
  readonly dir: string;
  /**
   * Explicit master key. When omitted, the store reads `master.key` from
   * {@link dir}, generating a fresh 32-byte key on first use.
   */
  readonly masterKey?: Buffer;
}

/**
 * File-backed encrypted credential store. Reads and writes a single AES-256-GCM
 * envelope under a `0600` master key, both inside the configured directory.
 */
export class CredentialStore {
  private readonly dir: string;
  private explicitKey: Buffer | undefined;
  private cachedKey: Buffer | undefined;

  constructor(options: CredentialStoreOptions) {
    this.dir = options.dir;
    this.explicitKey = options.masterKey;
  }

  private get keyPath(): string {
    return join(this.dir, KEY_FILE);
  }

  private get storePath(): string {
    return join(this.dir, CREDENTIALS_FILE);
  }

  /** Resolve the master key, generating and persisting one on first use. */
  private async key(): Promise<Buffer> {
    if (this.explicitKey !== undefined) return this.explicitKey;
    if (this.cachedKey !== undefined) return this.cachedKey;
    await mkdir(this.dir, { recursive: true });
    const existing = await readFileMaybe(this.keyPath);
    if (existing !== undefined) {
      this.cachedKey = parseMasterKey(existing);
      return this.cachedKey;
    }
    const generated = randomBytes(KEY_BYTES);
    await writeFilePrivate(this.keyPath, generated.toString('base64'));
    this.cachedKey = generated;
    return generated;
  }

  /** Load and decrypt the full credential map; `{}` when no store exists yet. */
  async load(): Promise<CredentialMap> {
    const raw = await readFileMaybe(this.storePath);
    if (raw === undefined) return {};
    const envelope = JSON.parse(raw) as EncryptedEnvelope;
    return decryptCredentials(envelope, await this.key());
  }

  /** Encrypt and atomically persist the full credential map. */
  async save(map: CredentialMap): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const envelope = encryptCredentials(map, await this.key());
    await writeFilePrivate(this.storePath, `${JSON.stringify(envelope, null, 2)}\n`);
  }

  /** Fetch one credential by name, or `undefined` if absent. */
  async get(name: string): Promise<StoredCredential | undefined> {
    return (await this.load())[name];
  }

  /** Store one credential under `name`, replacing any existing entry. */
  async set(name: string, credential: StoredCredential): Promise<void> {
    const map = await this.load();
    map[name] = credential;
    await this.save(map);
  }

  /** Remove one credential; returns whether it existed. */
  async remove(name: string): Promise<boolean> {
    const map = await this.load();
    if (!(name in map)) return false;
    delete map[name];
    await this.save(map);
    return true;
  }

  /** Names of all stored credentials. */
  async names(): Promise<string[]> {
    return Object.keys(await this.load());
  }

  /**
   * Every secret value across all credentials, for seeding the output redactor.
   * Returns `[]` (never throws) when the store is absent, so redaction setup on
   * a fresh machine is a no-op rather than an error.
   */
  async secrets(): Promise<string[]> {
    let map: CredentialMap;
    try {
      map = await this.load();
    } catch {
      return [];
    }
    const values: string[] = [];
    for (const credential of Object.values(map)) {
      values.push(...Object.values(credential.secrets));
    }
    return values;
  }
}

/**
 * A short, non-reversible fingerprint of a secret (first 8 hex of its SHA-256),
 * safe to display so a user can tell two stored secrets apart without revealing
 * either.
 */
export function secretFingerprint(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex').slice(0, 8);
}

/** Constant-time equality for two secrets, used when confirming a rotation. */
export function secretsEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  if (bufferA.length !== bufferB.length) return false;
  return timingSafeEqual(bufferA, bufferB);
}
