import { describe, expect, it } from 'vitest';
import { auditSandboxLabels, credentialScrub } from './index.js';

describe('auditSandboxLabels', () => {
  const identityLabels = {
    'racecar.managed': 'true',
    'racecar.project': 'demo',
    'racecar.mission': 'add-widget',
    'racecar.branch': 'feature/widget',
  };

  it('passes clean labels with no stored secrets present', () => {
    const result = auditSandboxLabels('sb-1', identityLabels, ['s3cr3t-token']);
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  it('flags a secret leaked into a label value as a leak that fails the audit', () => {
    const result = auditSandboxLabels(
      'sb-2',
      { ...identityLabels, 'racecar.mission': 'token is s3cr3t-token here' },
      ['s3cr3t-token'],
    );
    expect(result.ok).toBe(false);
    const leak = result.findings.find((f) => f.severity === 'leak');
    expect(leak?.key).toBe('racecar.mission');
    // The audit output must never contain the raw secret.
    expect(JSON.stringify(result)).not.toContain('s3cr3t-token');
  });

  it('flags a secret leaked into a label key', () => {
    const result = auditSandboxLabels('sb-3', { ...identityLabels, 'racecar.s3cr3t-token': 'x' }, [
      's3cr3t-token',
    ]);
    expect(result.ok).toBe(false);
    expect(result.findings.some((f) => f.severity === 'leak' && f.key.includes('s3cr3t'))).toBe(
      true,
    );
  });

  it('warns (without failing) on labels outside the racecar namespace', () => {
    const result = auditSandboxLabels('sb-4', { ...identityLabels, 'somevendor.owner': 'ci' }, [
      's3cr3t-token',
    ]);
    expect(result.ok).toBe(true);
    const warning = result.findings.find((f) => f.severity === 'warning');
    expect(warning?.key).toBe('somevendor.owner');
  });

  it('ignores empty secrets so an empty store never spuriously matches', () => {
    const result = auditSandboxLabels('sb-5', identityLabels, ['', '']);
    expect(result.ok).toBe(true);
    expect(result.findings).toHaveLength(0);
  });
});

describe('credentialScrub', () => {
  it('removes the git credentials file and unsets the helper for git', () => {
    const scrub = credentialScrub('git');
    expect(scrub.command).toContain('.git-credentials');
    expect(scrub.command).toContain('credential.helper');
    expect(scrub.livesInProcessEnv).toBe(true);
  });

  it('has no file to scrub for claude but still flags residual env exposure', () => {
    const scrub = credentialScrub('claude');
    expect(scrub.command).toBeUndefined();
    expect(scrub.livesInProcessEnv).toBe(true);
  });

  it('is conservative for unknown kinds: no command, no env claim', () => {
    const scrub = credentialScrub('mystery');
    expect(scrub.command).toBeUndefined();
    expect(scrub.livesInProcessEnv).toBe(false);
  });
});
