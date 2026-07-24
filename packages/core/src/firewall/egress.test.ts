import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EGRESS_ALLOWLIST,
  buildEgressPolicy,
  domainFromRemote,
  isEgressDomainAllowed,
  normalizeEgressDomain,
  parseEgressAllowlist,
} from './egress.js';

describe('egress firewall policy', () => {
  it('fails closed while allowing defaults, git, provider, and project extensions', () => {
    expect(
      buildEgressPolicy({
        repoUrl: 'git@code.example.test:team/racecar.git',
        providerApiUrl: 'https://daytona.internal.example.test/v1',
        extensions: ['packages.example.test', 'registry.npmjs.org'],
      }),
    ).toEqual({
      networkBlockAll: true,
      domainAllowList: [
        ...DEFAULT_EGRESS_ALLOWLIST,
        'code.example.test',
        'daytona.internal.example.test',
        'packages.example.test',
      ].sort(),
    });
  });

  it('extracts HTTPS and SSH git remote domains', () => {
    expect(domainFromRemote('https://gitlab.example.test/team/repo.git')).toBe(
      'gitlab.example.test',
    );
    expect(domainFromRemote('git@github.com:racecar/racecar.git')).toBe('github.com');
  });

  it('canonicalizes extensions and rejects unsafe domain syntax', () => {
    expect(parseEgressAllowlist(' Registry.Example.test,*.cache.example.test ')).toEqual([
      'registry.example.test',
      '*.cache.example.test',
    ]);
    expect(() => normalizeEgressDomain('https://example.test')).toThrow(/invalid egress domain/);
    expect(() => normalizeEgressDomain('example.test:443')).toThrow(/invalid egress domain/);
    expect(() => domainFromRemote('not a remote')).toThrow(/could not determine/);
  });

  it('allows an allowlisted destination and blocks an exfiltration destination', () => {
    const policy = buildEgressPolicy({ repoUrl: 'https://github.com/racecar/racecar.git' });
    expect(isEgressDomainAllowed(policy, 'api.anthropic.com')).toBe(true);
    expect(isEgressDomainAllowed(policy, 'collector.evil.example.test')).toBe(false);
  });
});
