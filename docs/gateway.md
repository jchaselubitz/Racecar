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
| `RACECAR_GATEWAY_POLL_MS` | no | Claim/wake poll interval; defaults to `5000`. |
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

## Railway

Create a Railway service from this repository and use
`deploy/railway/Dockerfile`. Railway reads `deploy/railway/railway.toml` for
the `/healthz` probe. Set every required variable in Railway's secret manager
and mount a persistent volume at `RACECAR_GATEWAY_STATE_DIR`. The gateway keeps
the request → sandbox → ACP-session mapping there, so an ephemeral filesystem
would allow a restart to create a second agent run for an already-claimed
Overlord request.

## Raspberry Pi

Copy `deploy/raspberry-pi/docker-compose.yml` and create a sibling `.env` with
the required variables. Start it with `docker compose up -d --build`. Keep the
gateway token in `.env` with owner-only permissions; never commit it.

## Lifecycle

For each claimed request the gateway resolves the project/resource from the
Overlord-registered working directory, resumes or creates the matching sandbox,
opens an ACP session through the shim, and translates the session-update stream
into `ovld protocol attach`/`update`/`heartbeat`/`ask`/`deliver`. A separate
always-on wake loop resumes stopped sandboxes for projects with queued work so a
claim never blocks on a slow restore. See
[`planning/gateway-runner-reuse.md`](../planning/gateway-runner-reuse.md) for the
full architecture.
