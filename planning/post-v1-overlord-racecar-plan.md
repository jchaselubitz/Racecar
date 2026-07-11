# Post-v1 Racecar–Overlord product and implementation plan

## Status and sequencing

This is the unified follow-on plan for the Git integration and execution-gateway
work. It begins only after the stages in
[`implementation-plan.md`](implementation-plan.md) are complete. That plan remains
the active build sequence; this document does not insert new requirements into
its current stages.

The supporting architecture documents remain the detailed design references:

- [`virtual-execution-target.md`](virtual-execution-target.md)
- [`racecar-overlord-execution-gateway.md`](racecar-overlord-execution-gateway.md)
- [`git-integration.md`](git-integration.md)

## Product definition

Racecar is a backend-free CLI and library that creates and operates mission cars.
Overlord is the durable orchestration system. A small Racecar execution gateway
connects the two by registering as an Overlord execution target and translating
claimed execution requests into idempotent Racecar operations.

Users choose between:

1. **Local Racecar target (`device.local:racecar`).** The gateway runs with the
   local device agent. It can use the current local checkout, including deliberate
   uncommitted or unpushed state, and works only while that device is online.
2. **Always-online Racecar target.** The same gateway runs on Railway, a Raspberry
   Pi, VPS, or home server. It uses a Git remote and continues launching cars while
   the user's laptop is offline.

The normal `device.local` target and `device.local:racecar` may coexist. The first
runs work directly on the device; the second provisions Racecar cars through the
configured sandbox provider. A target represents one gateway/provider credential
boundary, not an individual car.

## Product decisions

### Repository ownership

- GitHub, GitLab, Bitbucket, or another Git server is the canonical durable source
  for remote targets.
- The gateway does not host bare repositories or become a source-of-truth mirror.
  Temporary clones and bounded caches are implementation details and disposable.
- Local targets may package a filtered local checkout as a digest-addressed source
  archive. This is the explicit path for local-only and unpushed work.
- Code produced by a mission becomes durable through checkpoint commits pushed to
  a Git remote. Without a writable remote, Racecar reports reduced recovery and
  disables automated integration.

### Repository views and source compatibility

- Each target exposes a revision-aware repository view for file browsing, search,
  and mention completion. A remote gateway implements this with a cached bare
  mirror and disposable read-only worktrees; it does not expose a mission working
  tree or become a Git host.
- Mentions are informational navigation hints by default. Preserve their observed
  revision, optional content hash, and original excerpt, then resolve them against
  the source the car actually receives.
- Changed or missing informational references produce a drift report for the
  agent rather than blocking launch.
- Objectives that depend on local-only code, a particular revision, required
  paths or content, or an uploaded source bundle carry explicit source
  requirements. Unsatisfied requirements block launch unless explicitly
  overridden.
- Overlord infers this distinction conservatively from wording, local diffs,
  missing paths, named symbols, feature-area structure, and branch reachability;
  users should not classify every mention manually.
- Target changes trigger a source-compatibility preflight with `compatible`,
  `degraded`, or `incompatible` status. A stale individual file is generally
  degraded; a missing required feature area is incompatible.

The product rule is: repository drift is acceptable while references remain
useful navigation context. It is not acceptable when the selected source lacks
code required to understand or perform the objective.

### Multi-resource projects

- A Racecar project and its environment fingerprint cover the complete set of
  Overlord project resources, even when an objective begins in only one resource.
- Snapshots prepare the environment and tooling for every resource; repository
  contents remain separate and are materialized into the car after startup.
- Every resource has a stable `resourceKey` and deterministic workspace directory.
  Mentions, source requirements, checkout observations, mission branches,
  checkpoints, and integration state are qualified by that key.
- The car materializes all project resources before its first run. Objectives may
  change their active resource or work across several resources without replacing
  the mission car.
- Adding or removing a resource, or changing any resource's environment-relevant
  inputs, creates a new snapshot fingerprint. Switching the active resource does
  not.
- A car whose snapshot no longer covers the current resource set is incompatible
  and must be rebuilt or explicitly migrated before another run.

### Snapshot ownership

- Snapshots are immutable environment artifacts, not copies of a repository.
- A snapshot fingerprint includes the environment profile, toolchain/setup inputs,
  and dependency lockfile hashes, but not the current source commit by default.
- A newly created car always fetches a Git revision or receives a local source
  archive after startup. A snapshot must never contain Git, provider, agent, or
  Overlord credentials.

### Gateway packaging

Ship one versioned, multi-architecture gateway container and maintain two thin
templates:

- **Railway:** service template, health check, restart policy, documented secrets,
  and optional persistent cache/config volume.
- **Raspberry Pi:** Docker Compose and service/autostart configuration using the
  same image and configuration contract.

The templates run the gateway and Racecar adapter only. Cars continue to run at
the sandbox provider. Running cars directly on a Raspberry Pi is a different
future provider/adapter and is out of scope.

## Unified architecture boundary

| Concern | Owner |
| --- | --- |
| Missions, objectives, execution requests, approvals, audit | Overlord |
| Target registration, heartbeat, request claiming, translation | Gateway |
| Projects, environment snapshots, cars, runs, provider operations | Racecar |
| Branches, checkpoints, synchronization, integration queue | Racecar |
| Durable refs, commits, protected-branch enforcement | Git host |
| Sandboxes, snapshots, PTY transport, lifecycle primitives | Sandbox provider |

Overlord expresses intent and presents typed lifecycle resources. Racecar realizes
and reports observed state. The gateway does not introduce a second mission, run,
Git, or car state machine.

## Follow-on implementation phases

### Phase 1 — Freeze the contracts

**Goal:** agree on the smallest provider-neutral boundary before implementation.

Deliverables:

- Update the live Overlord `CONTRACT.md` and machine-readable contract before any
  boundary-crossing code.
- Define the Racecar gateway as an Overlord `rest-consumer` with a conformance
  manifest and vendored contract version.
- Define target registration/heartbeat, execution claim, launch acknowledgement,
  failure, and typed lifecycle-resource/event shapes.
- Define repository source and checkout observation contracts, external IDs,
  idempotency keys, health states, and typed errors.
- Define informational-reference, source-requirement, repository-view, and
  source-compatibility contracts, including explicit-override audit semantics.
- Define multi-resource launch and observation contracts, deterministic workspace
  layout, active-resource selection, and environment-compatibility behavior.
- Decide the user-facing target naming/identity rules; treat
  `device.local:racecar` as a display convention until the live Overlord contract
  confirms the canonical identifier shape.

**Exit criteria:** contract validation passes and both repositories have approved
decision records with no implementation-only assumptions.

### Phase 2 — Automation-ready Racecar

**Goal:** make every gateway operation safe, non-interactive, and recoverable.

Deliverables:

- Explicit `RACECAR_HOME`, caller-supplied external IDs, JSON/NDJSON output, stable
  errors, and concurrency-safe invocation.
- Idempotent project, snapshot, car, and run ensure operations.
- Multi-resource project ensure and car materialization keyed by stable resource
  identity, including safe active-resource switching within one mission car.
- Provider-label discovery sufficient to recover after loss of gateway cache.
- Repository materialization for Git sources and filtered local archives, with
  digest verification and secret exclusions.
- Revision-pinned repository browsing, mention resolution, and path/symbol/area
  compatibility preflight with original mention excerpts preserved.
- Environment-only snapshot fingerprints and short-lived credential injection.

**Exit criteria:** deleting gateway cache and retrying the same launch neither
duplicates resources nor loses an existing mission car.

### Phase 3 — Local Racecar execution target

**Goal:** prove the complete workflow on `device.local:racecar` before remote
packaging adds operational variables.

Deliverables:

- Local gateway registration, health, request claim, and Racecar launch adapter.
- Project source resolution from either the local checkout or a Git remote.
- Local repository-view observations, including dirty state and content hashes,
  plus degraded/incompatible detection when switching targets.
- One mission to one reusable car; one objective request to one idempotent run.
- Normal Overlord protocol attach, updates, questions, delivery, and launch expiry.
- Clear UI/status distinction between `device.local` and its Racecar capability.

**Exit criteria:** Overlord launches sequential objectives into the same mission
car from local checkouts, switches the active resource between objectives, and
retains correlation IDs and per-resource observed checkout state.

### Phase 4 — Always-online gateway and templates

**Goal:** make laptop-offline launching a self-hostable product path.

Deliverables:

- Versioned multi-architecture gateway image with startup validation and health
  endpoint.
- Railway template and Raspberry Pi Compose/service template.
- Git-host source resolution for public and private repositories using credential
  references; no credentials in launch payloads, logs, labels, or snapshots.
- Cached bare mirrors and disposable read-only worktrees for cloud repository
  browsing, with refresh rules that do not mutate existing draft context.
- Upgrade, rollback, backup, and credential-rotation documentation.
- A smoke test that submits from Overlord with the laptop offline and launches a
  car from each reference deployment.

**Exit criteria:** a new user can register either template, connect a Git-hosted
project, turn off their laptop, and successfully launch and deliver an objective.

### Phase 5 — Mission Git lifecycle

**Goal:** make concurrent mission output durable and safely integrable.

Deliverables:

- `.racecar/config.yaml`, durable mission branches, base/head SHA tracking, and
  pushed checkpoint commits.
- Manual enqueue/status/retry/dequeue integration workflow first.
- Resource-scoped serial integration queues with immutable candidate SHAs,
  compare-and-swap default-branch updates, and configured checks.
- Multi-resource delivery bundles containing one branch/candidate per modified
  repository, with explicit ordering and no claim of atomic cross-repository merge.
- Safe idle-car synchronization, overlap warnings, conflict return to the owning
  car, and post-merge cleanup policy.
- Typed integration resource and events presented by Overlord without duplicating
  Racecar's state machine.

**Exit criteria:** two concurrent missions deliver, queue, validate against the
latest default branch, and integrate serially; a conflict returns to the correct
mission car for resolution.

### Phase 6 — Remote supervision and hardening

**Goal:** make the remote target trustworthy for unattended daily use.

Deliverables:

- Authorized browser terminal proxy to the car's existing tmux session; no nested
  tmux and no provider credential in the browser.
- Reconciliation, stale-claim recovery, bounded caches, rate-limit backoff,
  redacted diagnostics, quotas, and audit events.
- Compatibility gates across Overlord contract, gateway, Racecar, and provider.
- Failure-injection coverage for gateway restart, provider outage, checkout
  failure, conflicting integration, and expired credentials.

**Exit criteria:** a sustained multi-project trial operates without manual resource
repair, source loss, duplicate runs, leaked credentials, or unbounded spend.

## Explicitly deferred

- Racecar-hosted Git service or durable repository mirrors.
- Cars running directly on the Raspberry Pi gateway host.
- A Racecar database or hosted Racecar control plane.
- Provider-specific repository types in the Overlord contract.
- Direct browser-to-provider terminal credentials.
- Speculative parallel integration before the serial queue is proven.

## Execution gate

Do not start this plan merely because an earlier implementation stage exposes a
convenient hook. Begin Phase 1 only after every stage and exit criterion in
`implementation-plan.md` is complete, then execute these phases in order unless a
new contract decision explicitly revises the sequence.
