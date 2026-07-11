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

## Integration states

The Racecar state machine should distinguish at least:

```text
working -> delivered -> queued -> rebasing -> testing -> merged
                |          |          |           |
                |          |          +---------> conflict
                |          +--------------------> superseded
                +-------------------------------> awaiting_approval
                                      testing --> checks_failed
```

`delivered` is an agent/objective outcome. `merged` is a Git integration
outcome. A mission is integrated only when its delivered SHA, or a traceable
rebased descendant of it, lands on the default branch.

Queue entries are immutable and contain the candidate SHA. A later delivery
supersedes an older queued candidate for the same mission rather than silently
changing what is being tested.

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
- `checks_failed`
- `conflict_detected`
- `integration_merged`

Overlord can translate these into mission activity, notifications, and UI.
Commands shown in Overlord delegate back to Racecar rather than executing Git
logic in Overlord. A prospective CLI surface is:

```bash
racecar integration enqueue --mission coo:252 --head def456
racecar integration status --mission coo:252 --json
racecar integration retry --mission coo:252
racecar integration dequeue --mission coo:252
```

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

1. Add `.racecar/config.yaml` parsing and validation, mission branch ownership,
   checkpoint push, and base/head SHA tracking.
2. Add a manual `racecar integration enqueue/status/retry/dequeue` workflow
   backed by a resource-scoped lock and compare-and-swap default-branch update.
3. Publish the integration resource and events through the existing Racecar to
   Overlord execution gateway.
4. Add the automated serial queue, safe idle-sandbox synchronization, overlap
   warnings, and post-merge lifecycle cleanup.
5. Optionally add hosted or pull-request-backed integration and speculative
   checks without changing the ownership contract.

The guiding rule is: **Racecar decides how code becomes mergeable; Overlord
decides when the mission should ask Racecar to do it and presents the result.**
