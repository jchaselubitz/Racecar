# Gateway as a self-provisioning Overlord runner — planning brief

## Status

Proposed. Supersedes the registration/claim portions of
[`virtual-execution-target.md`](virtual-execution-target.md) and
[`racecar-overlord-execution-gateway.md`](racecar-overlord-execution-gateway.md)
(specifically their reliance on `/api/virtual-targets/v1/*` registration and
claim). Read this alongside those docs — the domain model they describe (one
car per Overlord mission, one run per objective, gateway holds provider
credentials, Racecar owns snapshots/cars/runs, Overlord never sees provider
details) is unchanged and still correct. What changes is the wire protocol
between the gateway and Overlord, and where the `ovld` CLI lives.

This document is the brief for an agent to turn into a phased implementation
plan and objectives/issues in this repo. It is deliberately detailed because
the agent producing the plan has no memory of the conversation that produced
it — treat every section as load-bearing context, not background color.

## Why this changed

The original design (see `virtual-execution-target.md`) assumed Overlord would
build a whole parallel REST surface — target registration, claim, progress,
launched, failed, grant exchange, mission-resources, delegated-actions — under
`/api/virtual-targets/v1/*`, authenticated by a bespoke gateway credential
distinct from normal user auth. An audit of the Overlord repo found that
surface was never built beyond its contract text, DTOs, and unused DB
migrations (landed in commit `93dd8a1a`, contract v3) — no REST routes, no
service-layer code, no auth mechanism, no UI. `packages/gateway` in this repo
was built as a full client against that surface anyway, so it currently talks
to nothing.

Separately, working through what a gateway deployment actually needs revealed
that Overlord already has a fully-built, different mechanism that covers the
same ground with no new Overlord code at all: **a device that authenticates
with an ordinary user-scoped bearer token self-provisions as an execution
target the first time it makes an authenticated call.** This is the same
mechanism a laptop running `ovld setup` already uses, and it's also literally
the pattern already documented for containerized agents (`OVERLORD_USER_TOKEN`
env var, used by Overlord's own agent-pod tooling). Concretely, in Overlord's
`packages/core/service/execution-targets.ts`:

- `ensureActingDeviceTarget` / `ensureDeviceTargetForFingerprint` create (or
  reuse) a `devices` row and a `local`-type `execution_targets` row keyed by
  `(workspace_id, fingerprint)`, on the first authenticated call from that
  fingerprint. No admin approval step, no separate credential type — the
  caller just needs a normal Overlord bearer token (a `USER_TOKEN`, minted via
  `ovld user-token create`, or an equivalent OAuth-issued token) and a stable
  fingerprint string it supplies itself.
- Once that target exists, the existing local-runner queue lifecycle —
  `POST /api/runner/claim`, `.../requests/:id/launching`,
  `.../requests/:id/launched`, `.../requests/:id/failed` — works completely
  unmodified. This is the same lifecycle a laptop's `ovld runner` uses today;
  it is fully built, tested, and stable, unlike the virtual-target routes.
- `resolveWorkingDirectory` (in `packages/core/service/execution-requests.ts`)
  resolves a project's working directory from `project_resource_sources`,
  populated by `ovld add-cwd`/`ovld add-url`. It returns an **opaque string**
  that Overlord never opens or interprets — it's handed back to whatever
  claimed the request. Overlord genuinely does not care what's on the other
  side of that string.
- One execution target can already be the selected target for many different
  projects simultaneously — this is not a new capability to build, it's how a
  developer's laptop with several project directories checked out already
  works.

Net effect: **the gateway should just be an unusually well-behaved, always-on
local runner**, not a distinct kind of thing Overlord has to learn about. This
should require zero Overlord-side changes. (A companion Overlord-side mission,
`coo:268` in the Overlord repo, exists purely to verify this — not to build
anything.)

## The architecture

### Where `ovld` lives: the gateway, not the sandbox

Earlier thinking considered baking `ovld` into every sandbox's base snapshot
and having each sandbox's agent process call `ovld protocol` directly via the
installed connector hooks. That works, but it's worse than the alternative:
it distributes Overlord-awareness into every ephemeral sandbox image instead
of keeping it in one place.

Instead: **`ovld` runs only inside the gateway process.** Sandboxes stay
exactly as "dumb" as they are today for a non-Overlord Racecar user — an ACP
shim, the agent CLIs, git, and the project's checked-out resources. The
gateway is the only thing that ever speaks the Overlord protocol, and it
drives the mission lifecycle *remotely*, over the ACP shim connection that
already exists for exactly this purpose:

- `connectShim(provider, sandboxId, ...)` (`packages/cli/src/shim-connect.ts`)
  already lets an external process create a session inside a sandbox, stream
  session updates (tool calls, permission requests), and auto-approve
  permissions — see `startRun` in `packages/cli/src/run.ts`.
- The shim already captures `gitStatus`/`gitDiffStat` "at turn end" and
  reports them back over that connection (`ShimRunRecord.gitStatus` /
  `gitDiffStat`). This is the piece that makes remote-driven `ovld protocol
  deliver` possible without `ovld` ever touching the sandbox's filesystem
  directly — trust the shim's live report, not a gateway-side mirror, for
  changed-file detection specifically, since a gateway-side clone can drift
  from what the sandbox actually has checked out.

So "launching the agent" for an Overlord-originated request is: the gateway
claims the request via `ovld runner claim` semantics, resolves which
project/resourceKey/branch it names, resumes-or-creates the right sandbox,
connects to its shim instead of spawning a local process, and drives the
mission from there.

### One target, many projects

The gateway presents as **one execution target** in Overlord (or a small,
deliberately-sized number, not one per sandbox and not one per project). It
authenticates with a single `USER_TOKEN` and a **stable** device fingerprint —
stability matters: if the fingerprint changes on every redeploy/restart, every
deploy would silently create a brand-new device/target row in Overlord instead
of reusing the same one. Investigate how the vendored/adopted `ovld` client
computes its device fingerprint and how (or whether) that can be pinned
explicitly for a long-lived containerized process, rather than derived from
transient container identity. This is an open question for the plan to
resolve, not something to assume.

This single target claims work for **every project** it's configured to
serve, the same way one laptop can be the selected execution target for
several unrelated project directories. Concurrent missions on the same or
different projects become concurrent claims against that one target — nothing
about Overlord's claim logic needs to change for this (multiple concurrent
`claim` calls against the same target atomically grab different queued rows;
verify this holds under real concurrency as part of the plan, not just
by reading the code).

### Snapshot design: bake in every resource, at fixed paths

The project's Racecar snapshot should include **all** of that project's
registered Overlord resources (multi-repo/sibling-resource support), checked
out at a **fixed, conventional path per resource** — decided once when the
snapshot is built or rebuilt (on resource changes, or via the existing
`decideSnapshotRebuild`/`isSnapshotStale` lockfile-staleness logic in
`packages/core/src/domain/snapshot.ts`), not dynamically re-resolved on every
sandbox boot.

This matters for correctness, not just convenience: the gateway registers
each resource's location with Overlord via `ovld add-cwd --key <resourceKey>`
exactly **once per project** (at snapshot-build time, not per claim, not per
sandbox instance). Because every sandbox instance booted from that snapshot
has an identical resource layout, that one registered path is valid for *any*
future sandbox instance of that snapshot — there's no risk of one sandbox
instance's path being stale or wrong for a different instance, which would be
a real bug if paths were assigned ad hoc per boot.

### Driving the mission lifecycle remotely

The gateway, not the sandbox, calls `ovld protocol attach` / `update` /
`heartbeat` / `ask` / `deliver` on the mission's behalf, translating the ACP
session-update stream from the shim connection into the right calls:

- **`attach`** happens when the gateway starts working a claimed request.
  Attach's checkpoint (`refs/overlord/checkpoints/<objectiveId>`) needs *some*
  git ref access, but not necessarily the sandbox's literal working copy —
  since a checkpoint is just a ref pointing at a commit, the gateway can hold
  its own lightweight clone/mirror per project purely for ref operations, as
  long as it's kept current with the branch the sandbox is about to build on.
- **`update`/`heartbeat`** map from ACP session updates (tool calls, stage
  changes) as they stream in.
- **`ask`** needs an ACP-side equivalent — a blocking-question / clarification
  event the agent can raise mid-turn. Verify Racecar's ACP session-update
  vocabulary actually has this before assuming 1:1 parity; if it doesn't,
  that's a gap to design, not paper over.
- **`deliver`** fires at turn end, using the shim's already-captured
  `gitStatus`/`gitDiffStat` as the source of truth for the changed-file
  report — not a separate gateway-side diff computation.
- Real-time connector-hook fidelity (Overlord's `PostToolUse` edit-capture,
  `PermissionRequest` events) that would normally come from installed hooks
  inside the sandbox has to be reconstructed from the ACP event stream
  instead. This is a real translation layer to design and build, concentrated
  entirely in the gateway — that's the intended trade (all git/Overlord
  logic in one open-source-modifiable place) but don't underestimate it as
  "just call ovld from outside."

### State the gateway must own (Overlord doesn't track any of this)

A durable mapping of resourceKey/branch → live sandbox → active ACP session →
execution request. Overlord only ever sees the opaque resolved-working-directory
string per claimed request; everything about which physical sandbox is serving
which mission is Racecar's bookkeeping alone.

### Waking a stopped sandbox

Sandboxes still stop/archive when idle for cost reasons (existing behavior,
see `ensureStarted` in `run.ts` and the quota/reconcile modules). Something
has to notice a project has queued Overlord work and resume the right sandbox
before any claim can happen. Reuse `GET /api/runner/status?projectId=X` (or
confirm/extend it) as that signal — this replaces the old design's dependency
on a bespoke registration/heartbeat surface. A stopped sandbox can't poll for
itself, so this wake-up check has to live in the gateway's own always-on loop,
separate from the per-claim work.

### Merge-to-main integration queue — unaffected, but re-home its trigger

`packages/core/src/integration/*` and `racecar integration enqueue`/`run
--once` (`packages/cli/src/integration.ts`) are untouched by all of the above —
it's a self-contained, git-native state machine (worktrees + `git update-ref`
compare-and-swap) that never calls an Overlord API. Keep it exactly as is.

What does need to move: the old `packages/gateway/src/main.ts` polling loop
was the thing periodically firing `racecar integration run --once`. Since
`ovld` and the `racecar` CLI now coexist in the same gateway process, the more
natural trigger is event-driven — call `racecar integration enqueue` and
`racecar integration run --once` right after a successful `ovld protocol
deliver`, rather than on an unrelated timer.

### Idempotency

Carry over the one hard invariant from the original virtual-target design even
though the wire protocol changed: a gateway crash or restart after claiming a
request must not destroy or duplicate the sandbox or the run. Retrying the
same `executionRequestId` must resume/reuse, never re-provision from scratch.
This is now the gateway's own responsibility to enforce (via its state
mapping above), since Overlord's plain runner-claim lifecycle doesn't enforce
it for you the way the bespoke virtual-target contract was designed to.

## What this means for the existing `packages/gateway` package

Most of it should be replaced, not extended:

- `overlord-contract.ts` (vendored `/api/virtual-targets/v1/*` DTOs) and
  `client.ts` (the `OverlordClient` built against them) go away.
- `main.ts`'s registration/claim/progress/launched/failed loop against
  `/api/virtual-targets/v1/*` is replaced by driving `ovld` against the plain
  `/api/runner/*` surface plus `ovld protocol *`.
- `config.ts`'s required env vars change shape: still needs a backend URL and
  a credential, but the credential is now an ordinary `USER_TOKEN`, and
  `RACECAR_GATEWAY_LAUNCH_COMMAND` (the external opaque shell-out) is replaced
  by the real in-process launch adapter described above (shim connect +
  protocol bridge), not another shell-out.
- Decide, as an explicit early decision in the plan: does the gateway invoke
  `ovld` as a subprocess (mirrors the existing shell-out pattern, keeps a
  loose version coupling between the two repos, simplest to reason about), or
  import Overlord's protocol client as a library if one is published? Default
  to subprocess unless investigation finds a good reason not to — don't
  assume a library integration is available without checking.

### Decision: invoke `ovld` as a subprocess

**Use a direct `ovld` subprocess from the gateway.** As of the investigated
`overlord-cli` release (`0.2607121101.0`), the published npm package exposes
only the `ovld`/`overlord` binaries. Its package metadata has no `main`,
`module`, `types`, or `exports` entry, and its tarball contains a bundled CLI
application (`dist/index.js`), not a documented or separately published
TypeScript protocol-client library. The `@overlord/core` code mentioned in the
CLI documentation is bundled into that executable and is not a consumable
dependency boundary for Racecar.

This preserves the intended loose coupling: Racecar depends on the documented
CLI commands and their JSON output rather than importing Overlord internals.
The gateway deployment must install or image-pin a compatible
`overlord-cli` version, invoke it with `execFile`/argument arrays (not a
shell-composed command), and pass its backend URL, USER_TOKEN, and the
separately decided stable device-fingerprint override explicitly in the child
environment. Revisit a library integration only if Overlord publishes and
documents a supported client package with a stable protocol API.

## Explicit non-goals for this plan

- No new Overlord REST routes, DB tables, or auth mechanisms. If the plan
  finds something that seems to require an Overlord-side change, flag it back
  rather than assuming it can be built here — Overlord's side of this is
  being independently verified against the same design, not being changed by
  this document.
- Do not resurrect the `/api/virtual-targets/v1/*` client work in
  `packages/gateway` — that surface is being abandoned, not just deprioritized.
- Do not require `ovld` to be present in the base or per-project snapshot.

## What to do with this document

Produce a phased implementation plan (mirroring the structure of
`post-v1-overlord-racecar-plan.md`'s phases) and break it into objectives/
issues using this repo's normal conventions. Update or explicitly mark
superseded the relevant sections of `virtual-execution-target.md` and
`racecar-overlord-execution-gateway.md` (their registration/claim/health
sections specifically — their domain-model sections about cars, snapshots,
and mission-to-car mapping are still correct and should stay). Flag the two
open questions above (stable fingerprint pinning, subprocess-vs-library) as
early spikes, not assumptions baked into later phases.
