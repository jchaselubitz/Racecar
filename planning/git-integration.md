# Git integration for mission sandboxes

## Decision

Racecar owns the Git mechanics required by isolated mission sandboxes. Overlord
provides mission intent and displays integration state, but does not implement
branch creation, synchronization, rebasing, merge serialization, or conflict
resolution.

The model is:

- one durable Git branch per mission and repository resource that the mission
  modifies;
- frequent pushed checkpoint commits from that sandbox;
- one resource-scoped integration queue as the only automated writer to each
  repository's default branch; and
- a small, provider-neutral resource contract through which Racecar reports
  integration state and exposes actions to Overlord.

Git remains the durable source of truth. A sandbox filesystem is recoverable
working state, not the only copy of mission output.

For an always-online Racecar gateway, the durable repository lives on GitHub,
GitLab, Bitbucket, or another Git server. The gateway may keep disposable clones
or caches but does not host or mirror repositories as a product responsibility.
`device.local:racecar` may instead ingest a filtered local checkout so users can
deliberately launch from uncommitted or unpushed work; that source archive is
transport, not a durable replacement for pushed mission checkpoints.

An Overlord project may contain multiple repository resources, and one mission
car may move among or modify several of them. Every Git identity and state record
is therefore qualified by stable `resourceKey`: repository URL, base SHA, mission
branch, head SHA, checks, conflicts, and merged SHA. The mission remains one unit
of intent and one car, while each modified repository has its own branch and
serialized integration queue.

Git cannot atomically update default branches across independent repositories.
A multi-resource delivery is reported as a bundle of per-resource candidates,
not as one atomic merge. Racecar may order those candidates and stop after a
failure, but workflows requiring coordinated cross-repository rollout should use
explicit approval and repository-native pull requests or release coordination.

## Why the boundary belongs in Racecar

Concurrent branches, stale bases, dirty worktrees, and serialized merges are
consequences of the sandbox execution model. Racecar must solve them even when
it is used from a terminal without Overlord. Putting the policy and state
machine in Overlord would duplicate Racecar's lifecycle knowledge and make the
standalone CLI incomplete.

The ownership boundary is therefore:

| System | Owns |
| --- | --- |
| Overlord | Mission and objective identity, priority, approval intent, delivery lifecycle, and presentation of resources and alerts |
| Racecar | Mission branches, checkpoint pushes, base synchronization, overlap warnings, integration queue, checks, conflict handling, and sandbox cleanup |
| Git host | Durable refs and commits, protected-branch enforcement, atomic ref updates, and hosted check results where applicable |

Overlord must not need to understand worktrees, rebase commands, provider
locks, or the implementation of a merge queue.

## Repository configuration

Project behavior is committed with the project so it is versioned, reviewable,
and available to every Racecar client. The proposed location is
`.racecar/config.yaml`:

```yaml
version: 1

git:
  defaultBranch: main
  missionBranch: "ovld/{mission.displayId}-{slug}"

  checkpoints:
    pushOnObjectiveDelivery: true
    intervalMinutes: 20

  synchronization:
    updateIdleSandboxes: true
    updateAtObjectiveBoundary: true
    strategy: rebase

  integration:
    mode: queue
    mergeStrategy: squash
    requireApproval: false
    concurrency: 1

    checks:
      - yarn lint
      - yarn test
      - yarn typecheck

  cleanup:
    stopAfterMerge: true
    archiveAfterHours: 24
```

This file contains policy, not secrets or machine-specific settings. Git
credentials, provider credentials, organization quotas, and local overrides
remain in Racecar's user or control-plane configuration.

The schema should not assume Overlord is present. `missionBranch` may use
generic Racecar mission fields, with `mission.displayId` populated when the
caller supplies one. Projects may choose rebase-and-fast-forward or squash,
but should use one strategy consistently.

## Mission branch lifecycle

1. **Launch.** Racecar fetches the remote default branch, creates the mission
   branch from the current remote head, and records `baseSha`. It never relies
   on the source checkout baked into a snapshot being current.
2. **Work.** The sandbox creates coherent checkpoint commits and pushes them
   frequently. Sequential objectives for the mission reuse the same branch.
3. **Synchronize.** When the default branch advances, Racecar automatically
   updates only idle sandboxes with clean worktrees. Active or dirty sandboxes
   receive a pending-update notification and synchronize at the next safe
   objective boundary.
4. **Deliver.** Objective delivery records a pushed `headSha`. Delivery and
   integration are separate: a delivered mission may still await approval,
   checks, conflict resolution, or its turn in the queue.
5. **Queue.** Racecar queues an immutable commit SHA, not a moving branch name.
6. **Integrate.** The resource coordinator processes one candidate at a time,
   applies it to the latest default branch in a disposable checkout, and runs
   the configured checks. It updates the default branch only if its remote SHA
   still matches the expected value.
7. **Recover.** Failed checks and conflicts return to the owning sandbox. That
   sandbox resolves the problem, pushes a new head, and requeues it. A separate
   merge agent should not guess at semantic conflict resolution without the
   mission context.
8. **Complete.** Racecar records the merged SHA, notifies other active
   sandboxes that the default branch advanced, and applies the configured
   stop/archive policy.

Direct human updates to the default branch remain valid. Racecar detects the
new remote head and treats it like any other default-branch advancement.
Protected repositories should enforce that automated updates use the queue or
pull-request path.

## Integration state machine

Racecar records integration state per `resourceKey`. The happy path is:

```text
working -> delivered -> queued -> rebasing -> testing -> merged
```

The terminal or user-action exits are:

```text
delivered -> awaiting_approval -> queued
queued    -> superseded
rebasing  -> conflict
testing   -> checks_failed
any open state -> superseded
```

State meanings:

| State | Meaning | Owner of next action |
| --- | --- | --- |
| `working` | A mission sandbox exists or is expected to exist, and the branch may still receive commits. Racecar tracks `baseSha`, the mission branch, and the observed default branch head. | Sandbox/agent |
| `delivered` | The sandbox has pushed a concrete candidate commit and reported `headSha`. This does not imply it is safe or approved to merge. | Racecar policy or user |
| `awaiting_approval` | Project policy requires a human or caller decision before enqueuing the delivered candidate. | User/Overlord caller |
| `queued` | Racecar has accepted an immutable queue entry for a specific `headSha`. | Integration coordinator |
| `rebasing` | The coordinator is applying the queued candidate onto the current default branch in a disposable integration checkout. | Integration coordinator |
| `testing` | The candidate applied cleanly and the configured checks are running against the post-rebase commit. | Integration coordinator/check runner |
| `merged` | The candidate, or a traceable rebased/squashed descendant, landed on the default branch. Racecar records `mergedSha`. | None |
| `conflict` | Rebase or merge application failed. The owning sandbox must resolve and push a new `headSha`. | Sandbox/agent |
| `checks_failed` | The candidate applied cleanly but required checks failed. The owning sandbox must fix and push a new `headSha`, or a user must explicitly waive if project policy allows it. | Sandbox/agent or user |
| `superseded` | A newer delivery or explicit cancellation replaced this candidate. The old queue entry remains auditable but can never merge. | None |

`delivered` is an agent/objective outcome. `merged` is a Git integration
outcome. A mission is integrated only when its delivered SHA, or a traceable
rebased/squashed descendant of it, lands on the default branch.

The state machine is append-only from an audit perspective. A retry after
`conflict` or `checks_failed` creates a new delivery/candidate at a new
`headSha`; it does not mutate the failed queue entry.

### Commit identity fields

Racecar should carry these SHA fields on every integration resource:

| Field | Set when | Meaning |
| --- | --- | --- |
| `baseSha` | Branch creation and every successful sandbox synchronization | Default-branch commit the mission branch currently claims as its base. |
| `headSha` | Checkpoint push and delivery | Current pushed mission-branch commit. A delivered candidate must name this exact commit. |
| `queueBaseSha` | Enqueue | Default-branch commit observed when the immutable queue entry was created. |
| `rebasedSha` | Successful rebase/application | Candidate commit produced by applying `headSha` onto the latest default branch. Equal to `headSha` when no rebase was needed and the merge strategy preserves it. |
| `mergedSha` | Successful default-branch update | Commit now reachable from the default branch that represents the candidate. For squash merges, this is the squash commit. For fast-forward merges, this may equal `rebasedSha` or `headSha`. |

`baseSha`, `headSha`, and `mergedSha` are the minimum fields Overlord needs to
display continuity. `queueBaseSha` and `rebasedSha` are Racecar-owned details
that make the audit trail and retry behavior unambiguous.

### Immutable queue entries

The integration queue stores entries, not branch pointers. A queue entry is
created once and never edited in place:

```json
{
  "entryId": "intq_01J...",
  "resourceKey": "app",
  "missionId": "coo:252",
  "objectiveId": "af7c2f72-24c7-425d-9b26-7a259d46d767",
  "branch": "ovld/coo-252-git-management",
  "baseSha": "abc123",
  "headSha": "def456",
  "queueBaseSha": "789abc",
  "state": "queued",
  "priority": "normal",
  "createdAt": "2026-07-12T07:30:00.000Z",
  "supersedesEntryId": null
}
```

The coordinator may append derived observations to the entry record, such as
`startedAt`, `checks`, `conflict`, `rebasedSha`, `mergedSha`, and `finishedAt`,
but it must not change the identity fields that decide what code is being
integrated: `resourceKey`, `missionId`, `branch`, `baseSha`, `headSha`, and
`queueBaseSha`.

If a mission delivers again while an earlier entry is `queued`, `rebasing`,
`testing`, `conflict`, `checks_failed`, or `awaiting_approval`, Racecar creates a
new entry and marks the previous nonterminal entry `superseded`. A superseded
entry is not retried or merged even if its checks later pass.

### Compare-and-swap default-branch update

The integration coordinator is the only Racecar component that attempts to
advance a default branch. It must update the remote ref with compare-and-swap
semantics:

1. Fetch the remote default branch and record `expectedMainSha`.
2. Apply the immutable `headSha` onto `expectedMainSha` according to the project
   merge strategy.
3. Run required checks against the exact tree that would become the new default
   branch.
4. Re-read the remote default branch immediately before writing it.
5. Advance the default branch only if it still equals `expectedMainSha`.
6. If the compare-and-swap check fails, do not merge. Record
   `default_branch_advanced`, notify affected sandboxes, and move the entry back
   through `rebasing` against the new default branch unless it has been
   superseded.

For a direct Git remote, this is an atomic ref update with an expected old SHA.
For a protected Git host, Racecar should use the provider's merge/PR API only if
the provider can enforce the same expected-head condition or equivalent branch
protection. Hosted checks may satisfy the `testing` state, but the final write
still requires the compare-and-swap guard.

### Sandbox notifications when main advances

Whenever Racecar observes a new default-branch SHA for a resource, whether from
its own merge or a human push, it publishes a `default_branch_advanced` event:

```json
{
  "type": "default_branch_advanced",
  "resourceKey": "app",
  "defaultBranch": "main",
  "previousSha": "789abc",
  "newSha": "012def",
  "source": "racecar-integration",
  "mergedEntryId": "intq_01J...",
  "occurredAt": "2026-07-12T07:35:00.000Z"
}
```

Racecar delivers that event to every active sandbox for the same project
resource:

- idle clean sandboxes may be synchronized automatically, then their `baseSha`
  is advanced;
- active or dirty sandboxes receive a pending-main-update mailbox/control-plane
  notification and keep working until the next safe objective boundary;
- queued candidates behind the new default branch are reprocessed serially
  against the new SHA before they can merge; and
- Overlord receives the compact lifecycle resource update and may display a
  warning, but it does not run Git synchronization itself.

Notification delivery should be idempotent. A sandbox records the last
`defaultBranchSha` it has acknowledged per `resourceKey`, so repeated events do
not trigger repeated rebases.

## Minimal input from Overlord

Overlord supplies stable intent when it asks Racecar to create or run a mission
sandbox:

```json
{
  "projectId": "project-id",
  "missionId": "mission-id",
  "missionDisplayId": "coo:252",
  "objectiveId": "objective-id",
  "priority": "normal",
  "integrationIntent": "eligible-after-delivery"
}
```

`integrationIntent` may be omitted when the repository configuration provides
the default. Overlord does not choose branch names, provide Git commands, or
select a rebase implementation.

## Resource reported to Overlord

Racecar publishes a compact integration resource attached to the mission. A
multi-resource mission publishes one instance per modified repository resource:

```json
{
  "type": "integration",
  "provider": "racecar",
  "resourceKey": "app",
  "branch": "ovld/coo-252-git-management",
  "baseSha": "abc123",
  "headSha": "def456",
  "queueBaseSha": "789abc",
  "rebasedSha": null,
  "deliveredSha": "def456",
  "integrationState": "queued",
  "defaultBranch": "main",
  "defaultBranchSha": "789abc",
  "behindBy": 2,
  "checks": {
    "state": "pending",
    "url": "https://example.test/checks/123"
  },
  "conflict": null,
  "mergedSha": null,
  "actions": ["dequeue"]
}
```

Overlord stores or projects enough of this resource to render current status,
commit links, warnings, and available actions. It should not reproduce the
Racecar state machine in Overlord-specific columns. The general Overlord
concept required is that an execution target may publish typed lifecycle
resources and actions.

Racecar emits state-change events such as:

- `branch_created`
- `checkpoint_pushed`
- `default_branch_advanced`
- `integration_queued`
- `integration_rebasing`
- `integration_testing`
- `checks_failed`
- `conflict_detected`
- `integration_superseded`
- `integration_merged`

Overlord can translate these into mission activity, notifications, and UI.
Commands shown in Overlord delegate back to Racecar rather than executing Git
logic in Overlord. The implemented CLI surface is:

```bash
racecar integration status --resource app --mission coo:252 --json
racecar integration enqueue --resource app --mission coo:252 --head def456 --branch ovld/coo-252-git --json
racecar integration approve --resource app --entry intq_01J... --json
racecar integration retry --resource app --entry intq_01J... --head fed789 --json
racecar integration dequeue --resource app --entry intq_01J... --json
racecar integration run --resource app --once --json
```

`--resource <key>` selects the repository resource (default `primary`); `--project`
is accepted as an alias for it. The queue for a resource is persisted as
`.racecar/integration/<resourceKey>.json`, and every mutation runs under a
resource-scoped lock (`.racecar/integration/<resourceKey>.lock`).

CLI contract rules:

- Every command must support `--json` for gateway/Overlord callers and return a
  stable object with `ok`, `resourceKey`, `state`, and either `entry` or
  `resource`.
- `enqueue` requires an exact `--head` SHA and fails if the mission branch does
  not currently contain that commit. It returns the immutable `entryId`.
- `approve` moves an `awaiting_approval` entry to `queued`; it does not choose a
  different commit.
- `retry` is syntactic sugar for creating a new immutable entry after
  `conflict` or `checks_failed`. It requires the new pushed `--head` SHA and
  records `supersedesEntryId`.
- `dequeue` marks a nonterminal entry `superseded`; it does not delete the audit
  record.
- `run --once` processes at most one queue entry under a resource-scoped lock.
  A future daemon may loop over the same primitive, but the single-step command
  keeps the MVP debuggable.

## Continuity and concurrency

This model preserves the useful feel of several agents sharing an evolving
`main` while preventing them from sharing a filesystem or racing on one ref:

- checkpoint commits are small and integration turnover is fast;
- clean, idle sandboxes follow the default branch automatically;
- active sandboxes continue uninterrupted until a safe synchronization point;
- a project view can show queued candidates, ahead/behind counts, checks, and
  conflicts; and
- early diff overlap detection warns about likely contention without imposing
  unreliable path locks.

Final integration remains serial even if checks are run speculatively in
parallel. After each merge, every later candidate is validated again against
the new default-branch head.

## Delivery sequence

1. **Implemented.** `.racecar/config.yaml` parsing and validation, mission-branch
   naming, and base/head/queue SHA tracking. The pure policy resolver, state
   machine, immutable queue, and event/resource projection live in the
   `@racecar/core` integration module
   (`packages/core/src/integration/`); the CLI loads the config in
   `packages/cli/src/integration.ts`.
2. **Implemented.** A manual `racecar integration enqueue/status/approve/retry/dequeue`
   workflow plus `run --once`, backed by a resource-scoped lock, a JSON-persisted
   immutable queue, and a compare-and-swap default-branch update
   (`git update-ref` with an expected old SHA) performed in a disposable worktree
   by `LocalGitOps`.
3. Publish the integration resource and events through the existing Racecar to
   Overlord execution gateway. (The resource shape and events exist as pure
   projections; wiring them onto the gateway is the remaining step.)
4. Add the automated serial queue (looping `run --once`), safe idle-sandbox
   synchronization, overlap warnings, and post-merge lifecycle cleanup.
5. Optionally add hosted or pull-request-backed integration and speculative
   checks without changing the ownership contract. `LocalGitOps` implements the
   provider-neutral `IntegrationGitOps` interface, so a hosted/push-based
   implementation slots in without touching the state machine or queue.

The guiding rule is: **Racecar decides how code becomes mergeable; Overlord
decides when the mission should ask Racecar to do it and presents the result.**
