# Racecar implementation plan

Staged build sequence for the architecture described in the
[README](../README.md). Each stage has a goal, deliverables, and exit
criteria; a stage ships something usable on its own before the next begins.

After every stage and exit criterion in this plan is complete, continue with
the unified [post-v1 Racecar–Overlord plan](post-v1-overlord-racecar-plan.md).
That successor plan covers local and always-online Racecar execution targets,
self-hosted gateway packaging, and mission Git integration.

Stack: TypeScript, Node 24, Yarn workspaces. Packages: `packages/core`,
`packages/cli`, `packages/shim`.

## Stage 0 — Provider spike ✓ complete

**Goal:** validate every Daytona assumption the architecture rests on before
committing code to it. Throwaway scripts, not product code.

**Status:** complete. See `planning/stage0-decision-record.md` and
`spikes/stage0/FINDINGS.md` for full measured numbers. Key outcomes:

- **Container cold start: 1.18s mean** (0.93–1.34s range); warm start 0.98s;
  stop 1.90s; archive 17.94s (the only slow op); delete 0.34s. Lifecycle is
  interactive. Archive is the retention lever.
- **Auto-stop fires on control-plane inactivity, not in-sandbox CPU.** An
  agent process running inside the sandbox is not "activity." Any component
  that wants a sandbox alive during a long run must send an explicit heartbeat
  via `executeCommand` on an interval ≤ `autoStopInterval / 3`. Do not use
  the 1-minute minimum interval for sandboxes you intend to keep alive.
- **tmux survives client disconnect.** A detached tmux session kept running
  for a 20s client-disconnect window with zero ticks missed.
- **PTY attach/detach works.** `createPty` + `connectPty` reattach to the
  same shell in ~0.1s, proven via env sentinel.
- **WebSocket over preview URL: ~22ms median RTT.** Private-by-default auth;
  three token paths (header for programmatic clients, query param for
  browsers, signed TTL URL for hand-off). Reusable tokens; two concurrent
  clients both connect.
- **Claude OAuth injection confirmed.** Two concurrent disposable sandboxes
  completed non-interactive Claude Code runs with no login prompt (6.05s,
  6.58s) using a shared `CLAUDE_CODE_OAUTH_TOKEN`.
- **Codex ACP confirmed.** A full in-sandbox ACP session completed in 9.45s.
- **Labels confirmed.** ≥128 labels, ≥4KiB values, server-side filtering
  works. Non-secret routing/state fields only.
- **VM class deferred.** Daytona rejected VM snapshot creation in both `eu`
  and `us` ("no `linux-vm` runners configured"). No VM timings or cost delta
  were measured. Container default retained.

**Exit criteria:** met — see `planning/stage0-decision-record.md`.

## Stage 1 — Scaffold and control plane core

**Goal:** `racecar` can define a project, build a snapshot, and manage
sandbox lifecycle. No agents yet.

Deliverables:

- Yarn workspaces monorepo: `core`, `cli`, `shim` (shim is a stub), shared
  tsconfig/lint/test setup, CI.
- `core`: provider adapter interface (create/start/stop/archive/delete/
  snapshot/exec/PTY/preview-URL/labels) and the Daytona implementation.
- Domain model: Project, Snapshot, Sandbox, Run, plus the label/metadata
  schema that makes sandboxes self-describing.
- CLI: `racecar project init`, `racecar snapshot build`, `racecar sandbox
  create --project <p> --mission <name>`, `racecar ps`, `racecar sandbox
  stop|start|rm`.
- Fresh clone/checkout of the mission branch at sandbox creation; lockfile
  verification step (`--immutable` install) with a warning when the snapshot
  is stale relative to the lockfile.
- Lifecycle policies: auto-stop, auto-archive, retention, per-project
  concurrent-sandbox cap. Activity heartbeat while a CLI is attached/watching:
  send `executeCommand('true')` on an interval ≤ `autoStopInterval / 3`; do
  not use the 1-minute minimum interval for any sandbox that should stay alive.
- Snapshot recipe: bake in `ws` (for the Stage 3 shim) and `curl`/`iproute2`
  if lifecycle/health tooling needs them — the `node:24-bookworm-slim` base
  lacks all three. See `spikes/stage0/FINDINGS.md` objective-2 section.
- Test doubles for the provider adapter; integration tests against a
  dedicated Daytona org.

**Exit criteria:** with only a Daytona API key, a user can init a project,
build a snapshot, create two sandboxes for two branches, verify isolation,
and see accurate lifecycle state in `racecar ps`.

## Stage 2 — Credentials and the multiplex plane

**Goal:** agents run in sandboxes with working auth, supervised through the
terminal.

Deliverables:

- `racecar auth claude` (wraps `claude setup-token`), `racecar auth git`;
  local encrypted credential store; injection as env vars / 0600 files at
  sandbox creation. Redaction of credential values from all output and logs.
- tmux bootstrap baked into snapshots; every run executes inside a named
  tmux session. tmux survives full client disconnect (confirmed in Stage 0).
- Long-lived in-sandbox processes (tmux, the shim) must be started detached —
  via `tmux new-session -d` or a Daytona async session — never backgrounded
  as a child of a synchronous `executeCommand` (the exec hangs until exit).
- `racecar attach <sandbox>` — PTY attach to the sandbox's tmux session with
  detach, resize, and reconnect. `racecar ps` shows which sandboxes have an
  active agent. Expect ~0.1s reattach latency via `connectPty`.
- `racecar run <sandbox> "<prompt>"` — start an agent invocation (Claude Code
  first) as a Run inside tmux: sequential-run enforcement (one active run per
  sandbox), run records with timestamps, exit status, and a git diff/status
  summary captured at run end.
- NDJSON event output and `--json` on all commands so other programs can
  drive the CLI.

**Exit criteria:** a user runs two missions concurrently — `racecar run` on
each, `racecar attach` to watch either one, laptop lid closed and reopened —
with no login prompts and both runs completing with recorded results.

## Stage 3 — Shim and the chat plane

**Goal:** structured, live conversation with an in-sandbox agent from any
ACP client.

Deliverables:

- `packages/shim`: daemon started at sandbox boot (detached tmux session),
  serving ACP over a WebSocket on a preview URL; auth via per-sandbox token.
  Preview URL is private-by-default; three confirmed token paths — header
  (`x-daytona-preview-token`) for programmatic clients, `?DAYTONA_SANDBOX_AUTH_KEY`
  query param for browsers, `getSignedPreviewUrl` (TTL-bounded, no header) for
  hand-off to third-party ACP clients. Measured RTT: ~22ms median over the proxy;
  multi-client fan-in works (concurrent connections allowed).
- Southbound tier 1 adapter: Claude Code via its ACP adapter; Codex via
  `@agentclientprotocol/codex-acp`. Capability flags surfaced northbound.
- Southbound tier 2 (bridge) reference implementation for a stream-json
  agent, proving the tier boundary.
- `racecar chat <sandbox>` — terminal chat client over the shim, including
  permission-request prompts.
- Shim owns run state from here on: Stage 2's `racecar run` is rewired to go
  through the shim, so PTY and chat views describe the same session.

**Exit criteria:** a generic third-party ACP client (e.g. an editor) pointed
at the sandbox's preview URL can hold a session with the agent; `racecar
chat` and `racecar attach` can supervise the same run simultaneously.

## Stage 4 — Mailbox

**Goal:** set-and-forget communication; the user supervises many sandboxes
without a live connection to any.

Deliverables:

- Durable per-sandbox mailbox in the shim: user→agent instructions, agent→user
  questions/updates/completions, read/unread and awaiting-reply state.
  Survives sandbox stop/start.
- Delivery semantics per tier: mid-run injection for tier 1/2 agents where
  the protocol supports it; run-boundary prompt-prepend for tier 3.
- `racecar msg send <sandbox> "<text>"`, `racecar inbox` (aggregated across
  sandboxes, with per-sandbox filters), `racecar msg reply`.
- Agent-side conventions: completion and blocked-on-question events post to
  the mailbox automatically.
- Mailbox exposed over the same ACP WebSocket so a future mobile/web client
  needs nothing new from Racecar.

**Exit criteria:** queue instructions to three sandboxes, disconnect
entirely, return later to an inbox showing one completion, one question
awaiting reply, and one still running; reply to the question and see the run
proceed.

## Stage 5 — Hardening and fleet operations

**Goal:** safe to leave running unattended and cheap to operate.

Deliverables:

- Reconciliation loop for orphaned sandboxes and stuck runs; retention
  deletion; provider rate-limit backoff.
- Cost visibility: per-sandbox resource class and estimated spend in
  `racecar ps`; org/project quotas.
- Timeout enforcement inside and outside the sandbox; deterministic failure
  codes; bounded redacted log artifacts captured before cleanup.
- Snapshot staleness automation: lockfile-hash detection with an async
  snapshot rebuild path (`racecar snapshot build` promoted automatically or
  on demand).
- Security pass: preview-URL token rotation, credential revocation
  (`racecar auth revoke`), audit of what lands in labels vs. inside the
  sandbox.
- Egress firewall: apply Daytona's domain-level firewall at sandbox creation
  with a default allowlist (package registries, git remotes, the Anthropic
  API, provider endpoints) and per-project extension — constraining
  credential/data exfiltration by agents running arbitrary code with injected
  credentials. Verify in-allowlist destinations succeed and others are blocked.

**Exit criteria:** a week of real multi-mission use with no manual sandbox
cleanup, no leaked credentials in any log or label, no surprise spend, and
verified firewall behavior: approved destinations remain reachable while an
unapproved destination is blocked for every newly created sandbox.

## Stage 6 — Overlord adapter

**Goal:** Overlord launches and supervises Racecar sandboxes through its
existing execution-request protocol. Lives in the Overlord repo; Racecar
changes should be minimal.

Deliverables:

- Adapter translating a claimed execution request + mission context into
  Racecar CLI/JSON invocations; mission/objective IDs carried in sandbox
  labels and a workspace context file.
- Overlord runner path: claim → `racecar sandbox create`/`racecar run` →
  attach/deliver through the existing protocol; launch failures mark the
  existing execution request failed without a second state machine.
- Mobile/web supervision connects to the sandbox shim's ACP WebSocket
  (mailbox from Stage 4) — interface design itself is out of scope here.

**Exit criteria:** end-to-end mission from Overlord: objective queued →
sandbox created → agent run → delivery → lifecycle policy applied, with
correlation IDs intact throughout.

## Deferred / explicitly out of scope for v1

- VM sandbox class as the default (pause/resume with memory) — Stage 0 tried
  to measure this but Daytona had no `linux-vm` runners configured in either
  `eu` or `us` for this account. Container cold starts are 1.18s (interactive),
  so the container default stands. Revisit VMs only with a VM-enabled region,
  account-specific cost quote, and a confirmed process-tree-survives-resume
  result. `spikes/stage0/08-vm-lifecycle.ts` is the ready probe. No threshold
  rule was set (no measurements). Sandbox forking remains out of scope
  (conflicts with sequential runs).
- Hosted secret-manager integration (local encrypted store first). Daytona's
  secrets manager doesn't solve the token-rotation pain point (a Claude-auth
  property), so local-first stands for v1.
- GUI browser / VNC in sandboxes (HTTP previews and terminal only).
- Overlord mobile UI (consumes the Stage 4 surface; designed elsewhere).
- Multi-provider support beyond Daytona (the adapter boundary exists, but no
  second implementation until someone needs it).
