# Virtual execution targets

## Status

> **⚠️ Partially superseded by
> [`gateway-runner-reuse.md`](gateway-runner-reuse.md).** The
> `/api/virtual-targets/v1/*` wire contract this document specifies —
> capability advertisement, the versioned queue-input schema, the
> claim/progress/launch/failure output surfaces, health states, and the
> gateway registration/heartbeat flow — **was never built server-side.** Only
> DTOs and unused DB migrations landed in Overlord (commit `93dd8a1a`, contract
> v3); no REST routes, service code, auth mechanism, or UI exist for it. The
> gateway now self-provisions as an ordinary Overlord local runner
> (`ensureActingDeviceTarget` + the built `POST /api/runner/claim` /
> `.../requests/:id/launching` / `.../launched` / `.../failed` lifecycle) and
> drives the mission via `ovld protocol *`. Treat every section below tagged
> **[Superseded]** as historical; do not implement it.
>
> **Still correct and retained:** the domain-model sections — one car per
> Overlord mission, one run per objective, the identity mapping between
> snapshots/cars/missions, multi-resource project handling, and the layer /
> security ownership boundaries. Those are unchanged; `gateway-runner-reuse.md`
> builds on them.

Proposed provider-neutral contract for an Overlord execution target that creates
or reuses its actual execution environment after claiming a queued objective.
Racecar is the first adapter, but the Overlord contract must not require Racecar,
Daytona, snapshots, cars, or tmux.

This document defines the product concept and the expected runner queue boundary.
The live Overlord `CONTRACT.md` and machine-readable contract must be updated and
versioned before implementation.

## Definition

A virtual execution target is one stable, selectable Overlord target backed by a
gateway that can dynamically realize execution environments.

For Racecar:

- the target identifies a gateway installation and its provider/credential
  boundary;
- the gateway may run locally, on Railway, a Raspberry Pi, a VPS, or a home
  server;
- one Overlord mission maps to one reusable Racecar car;
- one objective execution request maps to one idempotent run inside that car; and
- cars are children of the target, not separately selectable execution targets.

The target is "virtual" because its working directory and compute do not need to
exist when the user queues the objective. The gateway realizes them after claim,
then reports what it actually created or reused.

This extends the existing runner model rather than replacing it. Overlord still
creates one durable execution request, assigns it to a target, and uses the normal
`queued -> claimed -> launching -> launched` or `failed` lifecycle. The agent still
attaches and delivers through the normal Overlord protocol.

## Capabilities

> **[Superseded]** Capability advertisement over the `/api/virtual-targets/v1/*`
> contract was never built. The gateway instead self-provisions as a plain
> Overlord runner and advertises nothing over a bespoke surface. See
> [`gateway-runner-reuse.md`](gateway-runner-reuse.md).

An execution target advertises capabilities rather than a provider-specific type:

```ts
interface VirtualTargetCapabilities {
  virtualEnvironment: true;
  multiResource: boolean;
  repositoryBrowse: boolean;
  localCheckoutSource: boolean;
  sourceBundleUpload: boolean;
  interactiveTerminal: boolean;
  mailbox: boolean;
  lifecycleActions: Array<'start' | 'stop' | 'archive' | 'delete'>;
  integrationActions: Array<'enqueue' | 'retry' | 'dequeue'>;
  supportedAgents: string[];
}
```

Capability advertisement lets `device.local:racecar` support local checkouts
while a remote Racecar gateway supports only Git-accessible sources. A future
virtual target may provision another kind of environment behind the same queue
contract.

## Layer responsibilities

The ownership boundaries in this table remain correct and are retained. Only the
wire mechanism changes: where the "Virtual-target gateway" row says *target
registration and heartbeat* and *claim handling*, read that as the plain runner
self-provisioning + `/api/runner/claim` lifecycle, **not** a
`/api/virtual-targets/v1/*` registration/heartbeat surface (which was never
built). See [`gateway-runner-reuse.md`](gateway-runner-reuse.md).

| Layer | Owns | Must not own |
| --- | --- | --- |
| Overlord client/UI | Target selection, objective authoring, initial resource selection, mention presentation, compatibility warnings, explicit overrides | Provider credentials, provider operations, car identity rules |
| Overlord backend | Projects, resources, missions, objectives, execution requests, target assignment, durable status, authorization, audit, queue payload construction | Snapshot construction, repository checkout mechanics, sandbox lifecycle |
| Overlord runner/queue | Durable delivery to one target, claim lease, retry/expiry, launch-state transitions | A second mission/run model, provider-specific DTOs |
| Virtual-target gateway | Target registration and heartbeat, claim handling, input validation, source preflight, translation to adapter calls, observed-state reporting | Durable Overlord mission state, Git hosting, semantic agent delivery |
| Racecar adapter | Idempotent project/snapshot/car/run ensure operations, repository materialization, environment compatibility, provider coordination | Overlord queue state, Overlord authorization, objective lifecycle |
| Racecar car/shim | Persistent mission workspace, one active run, tmux/ACP/mailbox supervision, direct agent protocol session | Target registration, queue claiming, provider credentials |
| Sandbox provider | Compute, immutable environment artifacts, PTY/network/lifecycle primitives | Missions, objectives, branches, integration policy |
| Git host | Durable repositories, refs and commits, protected-branch enforcement | Mission or execution-request state |

The queue item expresses desired state. Gateway and adapter outputs express
observed state. Overlord must not infer provisioning success merely from a claim,
and the gateway must not mark an objective complete because it launched an agent.

## Identity and lifetime

| Identity | Meaning | Lifetime/idempotency scope |
| --- | --- | --- |
| `executionTargetId` | Selected gateway installation | Stable until target deletion |
| `executionRequestId` | One queued launch attempt identity | Idempotency key for run start |
| `projectId` | Overlord project | Racecar project ensure key |
| `resourceId` | Durable Overlord project-resource ID | Resource reconciliation key |
| `resourceKey` | Stable contract/display key within the project | Workspace and reference qualifier |
| `missionId` | Overlord mission | Car ensure key |
| `objectiveId` | Objective being invoked | Run correlation and agent context |
| `environmentFingerprint` | Complete project environment version | Snapshot ensure key |

Names, paths, repository basenames, and branch labels are not identities.

## Queue input

> **[Superseded]** The `VirtualExecutionQueueItemV1` payload schema below was
> never built into Overlord's queue. The gateway now receives only the plain
> `/api/runner/claim` response plus `resolveWorkingDirectory`'s opaque
> working-directory string, and derives everything else itself. Retained for
> historical reference to the desired-state fields it once enumerated. See
> [`gateway-runner-reuse.md`](gateway-runner-reuse.md).

Overlord may add the following versioned payload to the existing execution-request
queue item. The exact storage shape is an Overlord implementation detail; this is
the boundary presented to the claiming runner or gateway.

```ts
interface VirtualExecutionQueueItemV1 {
  schemaVersion: 1;

  executionRequest: {
    id: string;
    targetId: string;
    queuedAt: string;
    attempt: number;
    priority: 'low' | 'normal' | 'high';
  };

  project: {
    id: string;
    name: string;
    environment: {
      profile: string;
      fingerprint: string;
      realization:
        | { kind: 'embedded'; definition: EnvironmentDefinition }
        | { kind: 'reference'; definitionRefId: string; digest: string };
    };
  };

  mission: {
    id: string;
    displayId?: string;
    title?: string;
    integrationIntent?:
      | 'none'
      | 'eligible-after-delivery'
      | 'approval-required';
  };

  objective: {
    id: string;
    displayId?: string;
    title?: string;
    sequence?: number;
    instruction: string;
    contextSnapshot?: string;
    contextBundleId?: string;
    attachments: AttachmentReference[];
    informationalReferences: InformationalReference[];
    sourceRequirements: SourceRequirement[];
    sourceCompatibilityOverride?: {
      approvedByUserId: string;
      approvedAt: string;
      reason?: string;
    };
  };

  resources: QueuedProjectResource[];
  activeResourceId: string;

  agent: {
    key: string;
    model?: string;
    reasoningEffort?: string;
    flags: string[];
    preCommand?: string;
  };

  lifecycle: {
    reuseMissionEnvironment: true;
    stopAfterMinutes?: number;
    archiveAfterMinutes?: number;
    retainUntilIntegrated?: boolean;
  };

  authorization: {
    launchGrantId: string;
    credentialRefIds: string[];
  };
}
```

```ts
interface EnvironmentDefinition {
  version: 1;
  baseImage: string;
  setupCommands: string[];
  tools: Record<string, string>;
  environmentFiles: Array<{
    resourceId: string;
    path: string;
    digest: string;
  }>;
}
```

The environment definition is provider-neutral desired state. The adapter decides
how to realize it as a snapshot or equivalent artifact. An immutable definition
reference is useful when the definition is large; the launch grant must authorize
the gateway to fetch it and its digest must verify before use.

The queue payload is an immutable launch snapshot. Later edits to the objective,
project resources, environment definition, or target settings do not rewrite an
already queued item. They require cancellation/requeue or a new execution request.
The retry `attempt` may advance while the desired launch snapshot and
`executionRequest.id` remain unchanged.

### Resource input

Every project resource required by the project environment is included, not only
the resource active when the objective is queued.

```ts
interface QueuedProjectResource {
  id: string;
  key: string;
  name: string;
  kind: 'git_repository';

  source:
    | {
        kind: 'git';
        url: string;
        credentialRefId?: string;
      }
    | {
        kind: 'local_checkout';
        targetRelativeRef: string;
        observedCommit?: string;
        contentDigest?: string;
        dirty: boolean;
      }
    | {
        kind: 'source_bundle';
        bundleId: string;
        digest: string;
      };

  checkout: {
    branch: string;
    baseBranch: string;
    commit?: string;
    createIfMissing: boolean;
  };

  environment: {
    definitionDigest: string;
    lockfileDigests: Record<string, string>;
  };
}
```

`targetRelativeRef` is an opaque reference meaningful only to the selected local
target; it is not a server filesystem path. A remote gateway rejects unsupported
local sources with a typed compatibility failure.

### Objective references

```ts
interface InformationalReference {
  resourceId: string;
  path: string;
  observedRevision?: string;
  observedContentHash?: string;
  excerpt?: string;
}

type SourceRequirement =
  | { resourceId: string; kind: 'path_exists'; path: string }
  | { resourceId: string; kind: 'revision_contains'; revision: string }
  | { resourceId: string; kind: 'content_hash'; path: string; hash: string }
  | { resourceId: string; kind: 'source_bundle'; bundleId: string };

interface AttachmentReference {
  id: string;
  name: string;
  mediaType: string;
  downloadGrantId: string;
}
```

Informational references do not require exact bytes. The gateway resolves them
against observed source and includes unchanged/changed/missing/renamed findings
and original excerpts in agent context. Unsatisfied source requirements block
launch unless the queue item contains an audited override.

### Required versus optional input

The minimum launchable item contains request, target, project, mission, objective,
all resources, one valid active resource, agent key, lifecycle defaults, an
environment fingerprint plus immutable environment definition, and a launch
grant. Model, effort, flags, attachments, references, requirements, integration
intent, and explicit lifecycle timings may use target/project defaults.

The queue item contains references to credentials and grants, never long-lived
secrets. The authenticated gateway exchanges grants through a documented Overlord
surface and injects only narrowly scoped, short-lived credentials into the car.

## Validation before claim and launch

> **[Superseded]** This validation split assumed the bespoke virtual-target
> claim surface. With the plain runner lifecycle, Overlord performs no
> virtual-target-specific pre-claim validation, and the gateway does its own
> post-claim checks against whatever `resolveWorkingDirectory` resolved. See
> [`gateway-runner-reuse.md`](gateway-runner-reuse.md).

Overlord validates before queueing:

- the target exists, is authorized for the project, and advertises the requested
  agent and source capabilities;
- every `resourceId` belongs to `projectId`;
- `activeResourceId` occurs exactly once in `resources`;
- the environment fingerprint was computed for the complete resource set; and
- the embedded or referenced environment definition is immutable, verifies its
  declared digest where applicable, and produces that fingerprint; and
- any source-compatibility override is attributable and auditable.

The gateway validates after claim:

- queue schema and adapter compatibility;
- grant validity and access to credential references;
- complete and unique resource identities;
- repository/source reachability;
- environment compatibility;
- informational-reference drift and all source requirements; and
- whether the existing mission environment can be safely reused.

A validation failure produces a typed failure output. It must not be represented
as an agent failure because no run has started.

## Outputs

> **[Superseded]** The `VirtualTargetClaimedV1` / `VirtualTargetProgressV1` /
> `VirtualTargetLaunchObservationV1` / `VirtualTargetFailureV1` output DTOs
> below were never built. The gateway now reports lifecycle transitions through
> the plain runner surface (`.../requests/:id/launching`, `.../launched`,
> `.../failed`) and drives mission-visible progress through `ovld protocol
> update`/`heartbeat`/`deliver`. See
> [`gateway-runner-reuse.md`](gateway-runner-reuse.md).

The gateway reports small versioned observations through the existing runner/REST
surface. Outputs are idempotent by `executionRequestId` and monotonically describe
progress; they do not create a parallel execution state machine.

### Claim acknowledgement

```ts
interface VirtualTargetClaimedV1 {
  schemaVersion: 1;
  executionRequestId: string;
  targetId: string;
  claimId: string;
  claimedAt: string;
  gatewayVersion: string;
  adapter: { key: string; version: string };
}
```

### Preparation progress

```ts
interface VirtualTargetProgressV1 {
  schemaVersion: 1;
  executionRequestId: string;
  sequence: number;
  stage:
    | 'validating'
    | 'resolving_sources'
    | 'checking_compatibility'
    | 'preparing_environment'
    | 'materializing_resources'
    | 'preparing_mission_environment'
    | 'starting_run'
    | 'awaiting_agent_attach';
  message?: string;
  occurredAt: string;
}
```

Progress is user-visible diagnostic state. It does not expand Overlord's closed
execution-request status vocabulary.

### Launch observation

```ts
interface VirtualTargetLaunchObservationV1 {
  schemaVersion: 1;
  executionRequestId: string;
  projectId: string;
  missionId: string;
  objectiveId: string;
  targetId: string;

  environment: {
    externalId: string;
    reused: boolean;
    fingerprint: string;
    state: 'ready' | 'running';
  };

  run: {
    externalId: string;
    startedAt: string;
  };

  activeResourceId: string;
  resources: ResourceObservation[];
  sourceCompatibility: SourceCompatibility;

  capabilities: {
    terminal: boolean;
    mailbox: boolean;
    lifecycleActions: string[];
  };
}

interface ResourceObservation {
  resourceId: string;
  resourceKey: string;
  sourceKind: 'git' | 'local_checkout' | 'source_bundle';
  branch: string;
  commit?: string;
  contentDigest?: string;
  dirty: boolean;
  workspaceRef: string;
}

interface SourceCompatibility {
  status: 'compatible' | 'degraded' | 'incompatible';
  resources: Record<string, {
    matchedPaths: string[];
    changedPaths: string[];
    missingPaths: string[];
    missingSymbols: string[];
  }>;
  overrideApplied: boolean;
}
```

`workspaceRef` is an opaque adapter-relative handle for later terminal or
lifecycle actions. Overlord should not treat it as a backend-readable path.

The gateway reports the launch observation when the car and run have been
started. Overlord marks the execution request `launched` according to its runner
contract. The agent's subsequent protocol `attach` is separate and remains the
proof of a durable agent session; stale-launch expiry remains authoritative.

### Failure output

```ts
interface VirtualTargetFailureV1 {
  schemaVersion: 1;
  executionRequestId: string;
  phase: 'claim' | 'validation' | 'preparation' | 'launch';
  code:
    | 'unsupported_contract'
    | 'target_configuration'
    | 'authorization_failed'
    | 'credential_unavailable'
    | 'resource_invalid'
    | 'source_unreachable'
    | 'source_incompatible'
    | 'environment_incompatible'
    | 'environment_preparation_failed'
    | 'provider_unavailable'
    | 'mission_environment_failed'
    | 'run_busy'
    | 'run_start_failed';
  retryable: boolean;
  message: string;
  resourceId?: string;
  details?: Record<string, unknown>;
  occurredAt: string;
}
```

Messages and details are redacted and bounded. `retryable` informs Overlord's
existing retry policy; the gateway does not independently requeue requests.

### Ongoing lifecycle resources

After launch, the target may publish typed resources attached to the mission:

- environment/car identity and lifecycle state;
- per-resource checkout observations;
- run state and mailbox availability;
- terminal-session capability and authorized actions;
- per-resource Git integration state, checks, conflicts, and merged SHA; and
- snapshot/environment compatibility warnings.

These are observations and actions, not new Overlord mission or execution-request
states. Commands delegate back to the virtual target.

## State and timing rules

> **[Superseded — wire mechanism only]** The claim-lease and launch-state
> transitions below now ride Overlord's plain `/api/runner/*` lifecycle, not
> the virtual-target claim/output surface. The underlying ordering (claim →
> launching → launched → agent attach → delivery) still holds and the
> idempotency invariant is retained — but it is now the gateway's own
> responsibility to enforce (see the idempotency section of
> [`gateway-runner-reuse.md`](gateway-runner-reuse.md)), since the plain runner
> lifecycle does not enforce it for you.

1. `queued`: Overlord has persisted the complete queue item for one target.
2. `claimed`: the gateway holds the normal lease and returns claim acknowledgement.
3. `launching`: validation and realization progress is underway.
4. `launched`: the adapter started the idempotent run and returned its observation.
5. Agent `attach`: the agent establishes the normal Overlord protocol session.
6. Protocol activity and delivery remain authoritative for objective execution.

Gateway crash before launch leaves recovery to the existing claim lease. Retrying
with the same `executionRequestId` returns or resumes the same run rather than
creating another. Gateway crash after launch must not stop the mission environment
or agent.

## Multi-resource behavior

- The queue item always describes the complete project resource set used to build
  the environment fingerprint.
- The virtual target prepares an environment compatible with every resource and
  materializes every resource into deterministic adapter-owned workspace paths.
- `activeResourceId` selects the initial working directory only. The agent may
  switch among resources during the mission without provisioning another car.
- Mentions, source requirements, observations, branches, checkpoints, and
  integration resources are qualified by resource identity.
- A changed active resource does not invalidate the environment. A changed
  resource set or environment-relevant input does.

## Security requirements

- No raw provider, Git, agent, or Overlord long-lived credential appears in the
  queue item, labels, structured output, or logs.
- Queue and attachment grants are short-lived, scoped, auditable, and exchanged
  only by the authenticated gateway.
- The gateway may cache repository objects and environment metadata, but these
  caches are disposable and bounded.
- Source bundles are filtered, digest-verified, secret-scanned, and deleted after
  their retention window.
- Browser terminal access requires a separate expiring authorization and never
  exposes provider credentials.
- Explicit source-compatibility overrides record user, time, reason, request, and
  observed incompatibility.

## Contract changes required in Overlord

> **[Superseded]** None of the Overlord-side contract work enumerated below is
> being pursued. `gateway-runner-reuse.md` deliberately requires **zero
> Overlord-side changes** — it reuses the already-built device self-provisioning
> and `/api/runner/*` claim lifecycle. Treat this list as abandoned scope, not a
> backlog. See [`gateway-runner-reuse.md`](gateway-runner-reuse.md), "Explicit
> non-goals for this plan."

Before implementation, Overlord should specify:

1. virtual-target capability advertisement and health semantics;
2. the versioned virtual execution payload attached to a queue item;
3. claim, progress, launch observation, and typed failure response surfaces;
4. target-relative resource browsing and opaque workspace references;
5. short-lived launch, attachment, and credential-reference grant exchange;
6. typed mission lifecycle resources and delegated actions;
7. repository reference and source-compatibility vocabulary; and
8. runner conformance tests covering retries, expiry, duplicate claims, target
   loss, incompatible source, and multi-resource launches.

Racecar should consume only these documented REST, queue, and protocol surfaces
and ship an Overlord `rest-consumer` conformance manifest. It must not access the
Overlord database directly.

## Initial acceptance scenario

> **[Superseded — wire steps only]** The domain outcome this scenario proves
> (one target, one car per mission, one run per objective, idempotent retry,
> multi-resource materialization) is retained, but the steps that name the
> "versioned queue item" and virtual-target REST surface are replaced by the
> plain runner claim + `ovld protocol` flow in
> [`gateway-runner-reuse.md`](gateway-runner-reuse.md).

1. A user selects an online Racecar virtual target and queues an objective for a
   project with two repository resources.
2. Overlord persists the complete versioned queue item and assigns it to the
   target.
3. The gateway claims it, validates grants and resources, and reports preparation
   progress.
4. Racecar ensures the project environment, reuses or creates the mission car,
   and materializes both repositories.
5. Informational-reference drift is reported as degraded context; all source
   requirements pass.
6. Racecar starts exactly one run in the active resource and returns per-resource
   observations.
7. Overlord marks the request launched; the agent attaches through the normal
   protocol and completes delivery.
8. Retrying the same execution request returns the existing car/run and creates
   no duplicates.

Passing this scenario proves the virtual-target boundary without requiring Git
integration automation or browser terminal proxying in the first increment.
