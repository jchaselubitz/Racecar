# Racecar gateway

`@racecar/gateway` is the long-lived worker that connects a single Overlord
execution target to Racecar for every configured project. It claims one plain
`/api/runner/*` request at a time, launches it in a Racecar sandbox through the
ACP shim, drives the mission lifecycle with `ovld protocol` on the agent's
behalf, and — right after a successful `ovld protocol deliver` — advances that
project's local serial Git integration queue with `racecar integration`.

It never reads the Overlord database and never completes an objective; the
`deliver` the gateway issues is what closes the mission turn. The target is
keyed by a stable device fingerprint, not registered/heartbeated over a bespoke
contract.

## Required inputs

| Variable | Required | Purpose |
| --- | --- | --- |
| `OVERLORD_BACKEND_URL` | yes | HTTPS URL of the Overlord backend. |
| `OVERLORD_USER_TOKEN` | yes | Ordinary Overlord bearer credential (a `USER_TOKEN`, minted via `ovld user-token create` or an OAuth-issued token); store only as a deployment secret. Rotating it must not change the target. |
| `RACECAR_GATEWAY_DEVICE_FINGERPRINT` | yes | Stable, opaque 32-hex device fingerprint for this logical gateway target. Generate once and keep unchanged across restarts, rebuilds, redeploys, and token rotation. See [`planning/gateway-device-fingerprint-decision.md`](../planning/gateway-device-fingerprint-decision.md). |
| `RACECAR_GATEWAY_STATE_DIR` | yes | A persistent, writable host/volume directory containing the `.racecar` project state and gateway request map. It must survive restarts and redeploys. |
| `RACECAR_GATEWAY_INSTANCE_ID` | recommended | Stable UUID for this deployment. Persist it across restarts. |
| `GATEWAY_NAME` | no | Human-friendly label for this gateway, sent to Overlord as the device label so it becomes the default execution-target name operators see. Display-only and safe to change; unset falls back to `RACECAR_GATEWAY_INSTANCE_ID`. |
| `RACECAR_GATEWAY_POLL_MS` | no | Claim/wake poll interval; defaults to `5000`. |
| `RACECAR_GATEWAY_BRANCH_STRATEGY` | no | Gateway-wide branching policy: `per-mission` (a dedicated branch/sandbox per mission) or `shared` (all missions in a project share one branch/sandbox, avoiding per-mission merges). Overrides Overlord's per-mission `mission.branch` decision; a per-claim launch mode still wins. Unset keeps the historical per-claim/Overlord defaults. |
| `RACECAR_GATEWAY_SHARED_BRANCH` | no | Branch used by the `shared` strategy; defaults to the project/Overlord base branch. Ignored unless `RACECAR_GATEWAY_BRANCH_STRATEGY=shared`. |
| `PORT` | no | Health server port; defaults to `8080`. |

Each project's merge-to-main integration queue is driven automatically from its
own registered repository (under `RACECAR_GATEWAY_STATE_DIR`) after a successful
`ovld protocol deliver` — there is no separate integration-repo variable and no
timer.

The gateway keys its single Overlord device/execution target by
`RACECAR_GATEWAY_DEVICE_FINGERPRINT`, not by a configured target ID: the plain
`/api/runner/*` surface resolves the target from the fingerprint the `ovld`
subprocess sends on every request. The old target-scoped gateway credential
(`OVERLORD_GATEWAY_TOKEN`), configured `OVERLORD_EXECUTION_TARGET_ID`, and the
external `RACECAR_GATEWAY_LAUNCH_COMMAND` shell-out are removed; the opaque
shell-out is replaced by the in-process launch adapter (shim connect + protocol
bridge). This doc's virtual-target registration/heartbeat framing is superseded
by [`planning/gateway-runner-reuse.md`](../planning/gateway-runner-reuse.md).

## Bundled command-line tools

The gateway image installs pinned `overlord-cli` and `racecar-cli` releases, so
the `ovld` and `racecar` subprocesses it uses do not depend on a base image or
project sandbox. Their pins live in
[`deploy/railway/Dockerfile`](../deploy/railway/Dockerfile). Override either at
build time with `--build-arg OVERLORD_CLI_VERSION=<version>` or
`--build-arg RACECAR_CLI_VERSION=<version>` when testing a compatible release.

The weekly [gateway CLI update workflow](../.github/workflows/update-gateway-cli-versions.yml)
queries npm for both `latest` releases and opens or refreshes a PR when a pin
changes. Run `node scripts/update-gateway-cli-versions.mjs` locally to refresh
the pins (or `yarn gateway:cli-versions`), or use
`yarn gateway:cli-versions:check` to make automation fail when they are stale.

## Railway

Deploy the prebuilt image `ghcr.io/jchaselubitz/racecar-gateway` (published by
`.github/workflows/publish-gateway.yml`), or build from this repository with
`deploy/railway/Dockerfile`. Railway reads `deploy/railway/railway.toml` for
the `/healthz` probe. Set every required variable in Railway's secret manager
and mount a persistent volume at `RACECAR_GATEWAY_STATE_DIR`. The gateway keeps
the request → sandbox → ACP-session mapping there, so an ephemeral filesystem
would allow a restart to create a second agent run for an already-claimed
Overlord request. Run a single replica: the device fingerprint keys one Overlord
target and the state lives on one volume, so a second replica double-claims
work. See [`../deploy/railway/README.md`](../deploy/railway/README.md) for the
full service/volume/variable setup.

## State durability preflight

Before it claims any work, the gateway preflights `RACECAR_GATEWAY_STATE_DIR`
so a lost volume never silently re-claims already-claimed Overlord work or
discards the `.racecar` project/Overlord state:

- It **refuses to start** when the state directory resolves inside the running
  image tree (the Dockerfile `WORKDIR`, `/app`). A container platform replaces
  that tree on every redeploy, so state kept there is deleted on each update —
  the exact "project/Overlord information deletes on every push" failure.
- It writes a persistence marker
  (`<state-dir>/.racecar/gateway-state/persistence.json`) recording the device
  fingerprint, first-seen time, and a boot counter, then re-reads it on every
  boot. A surviving marker logs `resumed persistent state directory (first seen
  …, boot #N)`; a missing marker after a redeploy or restart logs that the
  directory is not on a persistent volume and prior state was lost. A device
  fingerprint that differs from the one that initialised the directory is
  warned about, since it must stay stable across restarts and redeploys.

## Raspberry Pi

Copy `deploy/raspberry-pi/docker-compose.yml` and create a sibling `.env` with
the required variables. Start it with `docker compose up -d --build`. Keep the
gateway token in `.env` with owner-only permissions; never commit it.

## Lifecycle

For each claimed request the gateway resolves the project/resource from the
Overlord-registered working directory, chooses a sandbox launch mode, resumes
or creates the matching sandbox, opens an ACP session through the shim, and
translates the session-update stream into `ovld protocol
attach`/`update`/`heartbeat`/`ask`/`deliver`. A separate always-on wake loop
resumes stopped sandboxes for projects with queued work so a claim never blocks
on a slow restore. See [`planning/gateway-runner-reuse.md`](../planning/gateway-runner-reuse.md)
for the full architecture.

### Sandbox launch modes

Racecar no longer always provisions one sandbox per mission. On each claim the
gateway resolves a launch mode and places the run accordingly:

| Mode | Sandbox scope | Branch |
| --- | --- | --- |
| `mission-branch` | One sandbox per mission | Mission branch (created from the base branch when missing) |
| `branch` | One shared sandbox per project + branch | Caller-specified branch |
| `default-branch` | One shared sandbox per project | Project / Overlord base branch |

Resolution order:

1. Explicit claim metadata: `metadata.sandboxLaunch`, `sandboxLaunchMode`, or
   `launchMode` set to one of the three modes above. A branch name may be
   supplied as top-level `claim.branch` or `metadata.branch`.
2. Gateway branching strategy (`RACECAR_GATEWAY_BRANCH_STRATEGY`), applied to
   every claim this gateway serves:
   - `per-mission` → `mission-branch` (one dedicated branch/sandbox per mission)
   - `shared` → `default-branch`, or `branch` when
     `RACECAR_GATEWAY_SHARED_BRANCH` names a branch — all missions in the
     project share one branch/sandbox, so there is no per-mission merge step.

   This gateway-wide policy overrides Overlord's per-mission `mission.branch`
   decision but still yields to an explicit launch mode named on the claim.
3. Overlord's `mission.branch` object (fetched by the gateway):
   - `overrideBranch` → `branch`
   - `willPrepareBranch: true` (or `worktreePreference` of `branch`/`worktree`) → `mission-branch`
   - `willPrepareBranch: false` → `default-branch`
4. Otherwise: historical default — mission-scoped sandbox on the claim branch
   or the project default branch.

Shared project sandboxes are labeled with mission `project` and role `project`
so later claims on the same branch reuse them instead of creating another car.
