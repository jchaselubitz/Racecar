# Deploying the Racecar gateway on Railway

The gateway is distributed as a container image published to GHCR by
[`.github/workflows/publish-gateway.yml`](../../.github/workflows/publish-gateway.yml):

```
ghcr.io/jchaselubitz/racecar-gateway:edge      # latest main
ghcr.io/jchaselubitz/racecar-gateway:<version> # a released vX.Y.Z tag
```

You do **not** need to clone the repo or run the build toolchain to deploy — pull
the image. (Deploying from repo source with [`Dockerfile`](./Dockerfile) still
works; `railway.toml` points Railway at it for source-based deploys.)

## What to create in Railway

**One worker service + one volume.** No database, no public domain.

| Setting | Value |
| --- | --- |
| Service source | GHCR image `ghcr.io/jchaselubitz/racecar-gateway:edge` (or a pinned version) |
| Volume | Persistent volume mounted at the path you set for `RACECAR_GATEWAY_STATE_DIR` (e.g. `/data`) |
| Health check | `/healthz` (already declared in [`railway.toml`](./railway.toml)) |
| Public domain | None — the gateway only makes outbound calls to Overlord; nothing calls in |
| Replicas | Exactly **1** — the device fingerprint keys one Overlord target and state lives on one volume; a second replica double-claims work |
| Restart policy | `ON_FAILURE` (already in `railway.toml`) |

### Why the volume is mandatory

`RACECAR_GATEWAY_STATE_DIR` holds the `.racecar` project state and the
request → sandbox → ACP-session map. On an ephemeral filesystem, a restart can
re-claim already-claimed Overlord work and spawn a **duplicate agent run**. The
volume must survive restarts and redeploys.

The gateway now preflights this at boot so a misconfiguration is not silent:

- It **refuses to start** if `RACECAR_GATEWAY_STATE_DIR` points inside the image
  tree (e.g. under `/app`), because Railway replaces that tree on every redeploy
  — state kept there is guaranteed to be deleted on each update.
- It writes a persistence marker into the volume and re-reads it on every boot.
  If the marker survived, the boot log reads `resumed persistent state directory
  (first seen …, boot #N)`. If it is missing after a redeploy or restart, the
  log warns that the directory is **not** on a persistent volume and prior
  project/Overlord state was lost — check the volume mount and
  `RACECAR_GATEWAY_STATE_DIR` before real work is claimed.

## Variables

See [`../../docs/gateway.md`](../../docs/gateway.md) for the authoritative table.

Required:

| Variable | Notes |
| --- | --- |
| `OVERLORD_BACKEND_URL` | HTTPS URL of the Overlord backend |
| `OVERLORD_USER_TOKEN` | Overlord bearer token; store as a **Railway secret**. Rotating it must not change the target |
| `RACECAR_GATEWAY_DEVICE_FINGERPRINT` | Stable 32-hex string. Generate **once**, never change across restarts/redeploys/token rotation |
| `RACECAR_GATEWAY_STATE_DIR` | Must equal the volume mount path (e.g. `/data`) |

Recommended / optional:

| Variable | Notes |
| --- | --- |
| `RACECAR_GATEWAY_INSTANCE_ID` | Stable UUID for this deployment |
| `GATEWAY_NAME` | Human-friendly device label Overlord shows as the default execution-target name; display-only, falls back to the instance ID |
| `RACECAR_GATEWAY_POLL_MS` | Claim/wake poll interval; default `5000` |
| `RACECAR_GATEWAY_BRANCH_STRATEGY` | `per-mission` or `shared` |
| `RACECAR_GATEWAY_SHARED_BRANCH` | Branch for the `shared` strategy |
| `PORT` | Health server port; Railway injects this automatically (default `8080`) |

Generate a fresh device fingerprint once with:

```bash
openssl rand -hex 16
```

## Saving this as a reusable Railway template

Railway templates are created from a deployed service in the dashboard
(**Service → Settings → "Create Template"**). Build the service above once, then
publish it as a template so others can one-click deploy with the variable list
and volume pre-declared. Keep the image tag pinned to a released version in the
template rather than `:edge`.
