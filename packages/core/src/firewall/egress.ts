/** Default destinations needed by a JavaScript/TypeScript agent sandbox. */
export const DEFAULT_EGRESS_ALLOWLIST = [
  'api.anthropic.com', 'api.daytona.io', 'api.github.com', 'codeload.github.com', 'github.com',
  'objects.githubusercontent.com', 'registry.npmjs.org', 'registry.yarnpkg.com',
] as const;

export interface EgressPolicy {
  readonly networkBlockAll: true;
  readonly domainAllowList: readonly string[];
}

export interface BuildEgressPolicyInput {
  readonly repoUrl: string;
  readonly extensions?: readonly string[];
  readonly providerApiUrl?: string;
}

/** Validate a domain so a URL, port, or path cannot silently widen policy. */
export function normalizeEgressDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, '');
  if (
    domain.length === 0 || domain.length > 253 ||
    !/^(?:\*\.)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain)
  ) throw new Error(`invalid egress domain '${value}'`);
  return domain;
}

/** Extract a hostname from HTTPS/SSH git remote formats. */
export function domainFromRemote(repoUrl: string): string {
  const scpStyle = /^[^@\s]+@([^:\s]+):.+$/u.exec(repoUrl);
  if (scpStyle?.[1] !== undefined) return normalizeEgressDomain(scpStyle[1]);
  try { return normalizeEgressDomain(new URL(repoUrl).hostname); }
  catch { throw new Error(`could not determine a domain from repository URL '${repoUrl}'`); }
}

export function domainFromProviderUrl(providerApiUrl: string): string {
  try { return normalizeEgressDomain(new URL(providerApiUrl).hostname); }
  catch { throw new Error(`invalid provider API URL '${providerApiUrl}'`); }
}

/** Build the fail-closed policy. Projects can extend it, never weaken it. */
export function buildEgressPolicy(input: BuildEgressPolicyInput): EgressPolicy {
  const domains = new Set<string>(DEFAULT_EGRESS_ALLOWLIST);
  domains.add(domainFromRemote(input.repoUrl));
  if (input.providerApiUrl !== undefined) domains.add(domainFromProviderUrl(input.providerApiUrl));
  for (const extension of input.extensions ?? []) domains.add(normalizeEgressDomain(extension));
  return { networkBlockAll: true, domainAllowList: [...domains].sort() };
}

/** Parse a comma-separated CLI/config value into validated extension domains. */
export function parseEgressAllowlist(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim().length === 0) return [];
  return value.split(',').map(normalizeEgressDomain);
}

/** Whether a destination domain is permitted by a policy (for audit/tests). */
export function isEgressDomainAllowed(policy: EgressPolicy, destination: string): boolean {
  const domain = normalizeEgressDomain(destination);
  return policy.domainAllowList.some(
    (allowed) => allowed === domain || (allowed.startsWith('*.') && domain.endsWith(allowed.slice(1))),
  );
}
