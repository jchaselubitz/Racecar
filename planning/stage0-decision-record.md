# Stage 0 — Container lifecycle decision record

Measured numbers from the Stage 0 provider spike (`spikes/stage0/`), means over 3
iterations unless noted. Representative repo: [expressjs/express](https://github.com/expressjs/express) on `node:22-bookworm-slim`.

## Measured timings

| Operation | Mean | Range | Notes |
| --- | ---: | ---: | --- |
| Snapshot build | 48.3s | — | ~0.4 GB image |
| Cold start (from snapshot) | 1.18s | 0.93–1.34s | Create + start |
| First toolbox exec | 0.92s | — | First command after cold start |
| Stop | 1.90s | — | |
| Warm start | 0.98s | — | Start after stop |
| Archive | 17.94s | 13.55–23.74s | |
| Delete | 0.34s | — | |

## Conclusions

Create, stop, and start are all ~1–2s, so lifecycle is effectively interactive.
Archive (~18s) is the only slow operation and the natural retention lever.

These ~1s container cold starts support the **container-default** decision.
The VM / pause-resume comparison remains deferred: VM runner capacity was not
available to this Daytona organization in either `eu` or `us`, so no VM timing
or cost delta may be inferred from container data.

## Consolidated Stage 0 decisions

- **Container default: confirmed.** Cold create is 1.18s mean and warm start
  0.98s; credential and ACP workloads also completed in containers.
- **Shim over preview URL: confirmed.** The WebSocket proxy measured 22ms
  median RTT, private-by-default auth, reconnect, and multi-client fan-in.
- **Labels as a state index: confirmed with limits.** At least 128 labels and
  4KiB values work and server-side filtering is correct. Store only small,
  non-secret routing/state fields; keep credentials and logs inside the sandbox.
- **Credential plane: confirmed.** One Claude OAuth token served two concurrent
  non-interactive sandbox runs without a login prompt (6.05s, 6.58s).
- **Codex ACP: confirmed.** A full in-sandbox ACP session completed in 9.45s
  using the API-key auth path.
- **VM default: deferred, container default retained.** A runnable
  `spikes/stage0/08-vm-lifecycle.ts` probe covers lifecycle, pause/resume
  process survival, and hot-memory-snapshot restoration, but Daytona rejected
  VM snapshot creation in both configured targets because no `linux-vm` runner
  was configured. VM vs. container hourly pricing and memory-snapshot vs.
  archive storage pricing are unverified for this account. Revisit only with a
  VM-enabled region and an account-specific cost quote; do not set a threshold
  rule from absent measurements. VM fork remains deliberately out of scope for
  Racecar's sequential-run-per-sandbox model.
