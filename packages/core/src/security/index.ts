/**
 * Security operations: auditing that no secret leaked into a sandbox label, and
 * planning the in-sandbox scrub behind credential revocation.
 */
export type { AuditSeverity, LabelAuditFinding, SandboxLabelAudit } from './audit.js';
export { auditSandboxLabels } from './audit.js';

export type { CredentialScrub } from './scrub.js';
export { credentialScrub } from './scrub.js';
