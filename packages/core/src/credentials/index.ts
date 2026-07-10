/**
 * Credentials: a local encrypted store, redaction of secret values from output,
 * and injection of stored credentials into a sandbox at creation.
 */
export type {
  StoredCredential,
  CredentialMap,
  EncryptedEnvelope,
  CredentialStoreOptions,
} from './store.js';
export {
  CredentialStore,
  InvalidMasterKeyError,
  CredentialDecryptError,
  encryptCredentials,
  decryptCredentials,
  parseMasterKey,
  secretFingerprint,
  secretsEqual,
} from './store.js';

export { Redactor, REDACTION_MASK } from './redaction.js';

export type {
  ClaudeCredentialInput,
  GitCredentialInput,
  CredentialInjection,
} from './injection.js';
export {
  claudeCredential,
  gitCredential,
  buildCredentialInjection,
  CLAUDE_OAUTH_ENV,
  GIT_CREDENTIALS_ENV,
  DEFAULT_GIT_HOST,
  DEFAULT_GIT_USERNAME,
} from './injection.js';

export { extractClaudeToken } from './claude.js';
