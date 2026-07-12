/**
 * Vendored public subset of Overlord contract v4, commit d158f7d1b51f5789e4f8f5d147c130fe6eacdcf6.
 * Source: packages/contract/src/index.ts. Keep this file in sync with the pinned
 * upstream ref declared by the repository conformance manifest.
 */
export interface AgentLaunchConfigDto {
  preCommand: string;
  flags: string[];
}
export interface VirtualTargetCapabilitiesDto {
  localCheckoutSource: boolean;
  sourceBundleSource: boolean;
  browserTerminal: boolean;
  [key: string]: boolean | undefined;
}
export interface VirtualTargetRegistrationBody {
  executionTargetId: string;
  gatewayKey: string;
  gatewayInstanceId: string;
  gatewayVersion?: string | null;
  capabilities: VirtualTargetCapabilitiesDto;
  supportedAgents: string[];
  supportedQueueVersions: string[];
  connection?: Record<string, unknown>;
}
export interface VirtualSourceDescriptorV1 {
  kind: string;
  url?: string;
  ref?: string;
  commit?: string;
  credentialRef?: string | null;
  targetRelativeRef?: string | null;
  bundleRef?: string | null;
  observedContentDigest?: string | null;
}
export interface VirtualProjectResourceV1 {
  resourceId: string;
  resourceKey: string;
  label: string | null;
  source: VirtualSourceDescriptorV1;
  active: boolean;
}
export interface VirtualExecutionQueueItemV1 {
  schemaVersion: 'v1';
  executionRequestId: string;
  executionTargetId: string;
  workspaceId: string;
  projectId: string;
  missionId: string;
  objectiveId: string;
  environment: { definitionId: string; version: number; fingerprint: string; digest: string };
  resources: VirtualProjectResourceV1[];
  activeResourceKey: string;
  sourceRequirements: { resourceKey: string; kind: string; reason: string }[];
  informationalReferences: { resourceKey: string; compatibility: string; excerpt: string | null }[];
  agent: string;
  model: string | null;
  reasoningEffort: string | null;
  launchConfig: AgentLaunchConfigDto;
  grants: { grantId: string; kind: string; expiresAt: string }[];
  payloadDigest: string;
}
export interface VirtualTargetClaimResponseDto {
  claimId: string;
  expiresAt: string;
  queueItem: VirtualExecutionQueueItemV1;
}
export interface VirtualTargetProgressObservationBody {
  claimId: string;
  sequence: number;
  stage: string;
  message?: string | null;
  percent?: number | null;
  observedAt: string;
}
export interface VirtualTargetLaunchObservationV1 {
  claimId: string;
  sequence: number;
  payloadDigest: string;
  externalRunId?: string | null;
  externalEnvironmentId?: string | null;
  observedAt: string;
}
export interface VirtualTargetFailureV1 {
  claimId: string;
  sequence: number;
  failureCode: string;
  /** Open vocabulary: core values include claim, source, environment, and launch. */
  failurePhase: string;
  retryable: boolean;
  message?: string | null;
  observedAt: string;
}
