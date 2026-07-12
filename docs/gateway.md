# Racecar gateway

`@racecar/gateway` is the long-lived worker that connects an Overlord virtual
execution target to Racecar. Run one instance per Overlord execution target. It
registers and heartbeats the target, claims one immutable request at a time,
reports preparation and launch outcomes, and can drive the local serial Git
integration queue between claims.

It is a target-authenticated Overlord contract-v4 REST consumer. It never reads
the Overlord database and never completes an objective; the agent still does
that through `ovld protocol deliver`.

## Required inputs

| Variable | Required | Purpose |
| --- | --- | --- |
| `OVERLORD_BACKEND_URL` | yes | HTTPS URL of the Overlord backend. |
| `OVERLORD_GATEWAY_TOKEN` | yes | Target-scoped gateway bearer token; store only as a deployment secret. |
| `OVERLORD_EXECUTION_TARGET_ID` | yes | The single virtual target this gateway represents. |
| `RACECAR_GATEWAY_LAUNCH_COMMAND` | yes | Command that materializes the JSON request and starts the Racecar sandbox/run. |
| `RACECAR_GATEWAY_INSTANCE_ID` | recommended | Stable UUID for this deployment. Persist it across restarts. |
| `RACECAR_GATEWAY_POLL_MS` | no | Claim/heartbeat interval; defaults to `5000`. |
| `RACECAR_INTEGRATION_REPO` | no | Git checkout whose `racecar integration run --once` queue is driven automatically. |
| `PORT` | no | Health server port; defaults to `8080`. |

The launch command receives `RACECAR_GATEWAY_REQUEST_FILE` (an immutable
`VirtualExecutionQueueItemV1` JSON file) and `RACECAR_GATEWAY_CLAIM_ID`. It
must materialize only the sources and grants authorized by that request, then
start exactly one Racecar run. It must be idempotent by `executionRequestId`.

## Railway

Create a Railway service from this repository and use
`deploy/railway/Dockerfile`. Railway reads `deploy/railway/railway.toml` for
the `/healthz` probe. Set every required variable in Railway's secret manager;
mount a persistent volume if the launch adapter keeps local state or Git caches.

Do not set `RACECAR_INTEGRATION_REPO` unless that repository is present in the
deployment (typically a private Git clone/materialization cache). The gateway
does not host a source-of-truth repository.

## Raspberry Pi

Copy `deploy/raspberry-pi/docker-compose.yml` and create a sibling `.env` with
the required variables. Start it with `docker compose up -d --build`. Keep the
gateway token in `.env` with owner-only permissions; never commit it.

## Current boundary

The included command adapter deliberately keeps source materialization outside
the gateway loop while Racecar's stable gateway launch API is introduced. This
makes the worker deployable now without inventing a second sandbox lifecycle.
The command is the only component allowed to translate the request into local
Racecar project/sandbox/run calls; the gateway itself only owns Overlord REST
claim/reporting and the integration-loop cadence.
