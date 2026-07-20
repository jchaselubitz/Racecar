---
name: overlord-integrations
description: >-
  How to navigate the cooperativ-labs/Overlord repository to build an integration
  (agent connector, database/auth/REST extension, automation, MCP surface, or a
  downstream client that talks to the protocol/REST API). Explains the contract-first
  workflow — where the contract lives, how to reference it, and how to check your
  component against it with `ovld contract check` — plus the repo map and the exact
  files an integration must add. Use when writing, reviewing, or debugging any code
  that crosses an Overlord module boundary.
---

# Building Integrations for Overlord

Overlord (`https://github.com/cooperativ-labs/Overlord`) is an open-source management
layer for AI coding agents. Work is organized into **missions** (a whole feature/goal)
containing ordered **objectives** (one objective ≈ one agent session). The backend
persists objectives, history, attachments, artifacts, and shared state so agents keep
continuity across sessions, and every file change is recorded with a structured
**change rationale**.

Overlord is a **contract-first monorepo**. Modules are deliberately isolated and only
talk through declared surfaces. The single most important rule for any integration:

> **Read and, if needed, update `CONTRACT.md` *before* writing code that crosses a
> module boundary. Contract changes land before implementation.**

This skill tells you how to navigate the repo and how to reference and check against the
contract. The concrete contract facts you need most often are embedded below so you
rarely have to leave this file — but always confirm against the live repo, since the
contract is versioned and evolves.

### Launch-time project resources and environment variables

An integration launched by Overlord receives resource context **twice**:

1. At process launch, in environment variables built by the launch plan.
2. After `ovld protocol attach`, in the returned `projectResources` array, refreshed for
   the execution target.

Treat the launch environment as the early, machine-local handoff; use `attach` as the
authoritative protocol refresh. Do not read Overlord tables or a resource's private
configuration to fill in missing launch data.

| Launch value | Contracted meaning | How an integration should use it |
|---|---|---|
| `OVERLORD_PROJECT_RESOURCES` | JSON array of every logical project resource resolved for this execution target. Each entry has `resourceKey`, `label`, `isPrimary`, `isCurrent`, `accessMode` (`read_write` or `read`), `path` (string or `null`), and `state`. It is set only when the project has resources. | Parse it as JSON; use resource keys to label/reconcile repositories and use only non-null local paths that the runner has made available. |
| `OVERLORD_PROJECT_RESOURCES_PATHS` | Comma-separated connected absolute paths, each suffixed `:rw` or `:ro`. A missing suffix is accepted by parsers as `rw` for backwards compatibility, but launchers now emit explicit suffixes. | Useful for path allowlists. Preserve the suffix semantics: `:ro` is reference-only and must not be modified. |
| `OVERLORD_PROJECT_RESOURCES_PATHS_CSV` | Backward-compatible alias of `OVERLORD_PROJECT_RESOURCES_PATHS`. | Prefer the non-`_CSV` name in new integrations; accept the alias when compatibility requires it. |
| `OVERLORD_PRIMARY_RESOURCE_PATH` | Local path of the primary (or current) resource, or empty when it is not connected locally. | Use as the default working repository only; it is not a list of all project repositories. |

The agent's terminal has one working directory, while the manifest is plural. A sibling
with `path: null` is a real project resource that is unavailable on this machine, not a
path to invent. The primary resource is always `read_write`; non-primary `read` resources
are reference repositories. URL/Git sources have no local path, so they are omitted from
the `*_PATHS` values.

Project Settings may additionally define `launchEnvVars` and `preLaunchCommands`. The
runner resolves `{OVERLORD_VARIABLE}` placeholders while building the launch plan, exports
the resulting environment, then runs the pre-launch commands before starting the agent.
`{VAR}` refers only to Overlord's built-in launch context; after export, user-defined vars
are ordinary shell variables referenced as `$NAME`. `projectResources` and the session key
exist only after attach and cannot be used in `{VAR}` substitution.

#### Racecar / GitHub checkout rule

Racecar should parse `OVERLORD_PROJECT_RESOURCES` before work begins, then reconcile the
same resource keys against the `projectResources` array returned by attach. For each entry:

1. Use an available local `path` directly and honor `accessMode` (`read` means inspect,
   never edit).
2. If `path` is `null`, record that the resource is unavailable locally; do not infer a
   GitHub owner/repository from the resource key or attempt a clone from a guessed URL.
3. Keep file changes and delivery rationales scoped to the current, writable working
   resource unless an objective explicitly launches Racecar into another resource.

**Important current limitation:** the public launch/attach resource manifest exposes
resource identity, local path, state, and access mode — **not** a Git source URL. Although
Overlord project resources may have a secret-free `git` source registered (for example via
`ovld add-url --url <git-url>`), the current manifest deliberately omits that descriptor.
Therefore project resources alone cannot yet tell Racecar which unavailable GitHub
repositories to pull. A project may temporarily supply an explicit, non-secret
`RACECAR_GITHUB_REPOSITORIES` (or equivalent) through `launchEnvVars`, but it must be kept
in sync manually and must never contain credentials.

To make automatic checkout discovery a supported integration feature, change the
Overlord contract first: add an explicitly secret-free Git source projection (for example
`sourceKind` plus `sourceUrl`) to the launch and attach resource-manifest schemas; define
which source kinds and URL schemes are permitted; document availability/state behavior;
then bump the contract version and update `CONTRACT.md`, the machine-readable contract,
launch-variable catalog, DTOs, tests, and examples. Only after that contract change should
Racecar clone a declared URL, using its own GitHub credential flow and a destination outside
the primary working tree. Never expose tokens, SSH private keys, or credential-bearing URLs
through the manifest or `launchEnvVars`.

---

## 1. Repo map (what lives where)

Yarn 4 monorepo. Each workspace owns a boundary; `contract/` is the wiring diagram.

| Path | Owns | You touch it when… |
|------|------|--------------------|
| `CONTRACT.md` | Normative narrative spec for all cross-module interaction | **Always read first.** Update before any boundary-crossing change |
| `contract/` | Machine-readable contract: `components.yaml`, `protocol-commands.yaml`, `extension-points.yaml`, `conformance-manifest.schema.yaml`, `branch-planning-vectors.json`, `examples/` | Validating your manifest, checking allowed capabilities/vocabularies |
| `packages/core/` | Shared protocol + service layer, DB types | Adding service operations reused across modules |
| `cli/` | The `ovld` command: management commands, `ovld protocol <cmd>`, config resolution, branch planning (`cli/src/branch-planning.ts`) | The protocol commands your agent invokes; CLI-side integration |
| `webapp/` | REST + realtime API, DTO shapes, webhooks, OAuth | Adding REST endpoints, consuming the REST API, webhooks |
| `database/` | Schema, migrations, `DatabaseClient` adapter | New tables (as an extension), alternative DB backend |
| `auth/` | Tokens, RBAC, Better Auth tables | Custom auth/RBAC provider |
| `connectors/` | Agent harness plugins (Claude Code, Codex, Cursor) | **Building a new agent connector — the most common integration** |
| `automations/` | Pluggable AI features (summarize, auto-title) | Custom automation via `OVERLORD_AUTOMATIONS_MODULE` |
| `mcp/` | Hosted MCP server (`/mcp`), tool schemas, widgets | Cloud/MCP agent surface |
| `desktop/` | Optional Electron shell (not built by default) | Desktop packaging/supervision |

Start reading here: `README.md` → `CONTRACT.md` → `docs/README.md` (doc index) →
`TEST_PLAN.md` (conformance test strategy) → the `<module>/docs/` for the boundary you
touch. For connectors specifically: `connectors/README.md` and `connectors/AGENTS.md`.

### Local dev quickstart
```bash
yarn install                 # single install at root
cp .env.local.example .env.local
yarn db:start                # local SQLite
yarn dev                     # API on :4320, Vite on :5173
yarn check                   # lint + typecheck + test
```

---

## 2. Pick your extension point

Overlord permits **only** the sanctioned extension points below. Anything else —
patching core tables, undeclared hooks, closed-vocabulary values — violates the
contract. (Source of truth: `contract/extension-points.yaml`.)

| Extension point (id) | Owner | Use it to… |
|----------------------|-------|-----------|
| `custom-connector` | connector | Support a new agent harness (CLI/IDE). **Most integrations are this.** |
| `custom-harness` | extension | User/workspace-authored harness definitions (`user_harness_extensions`) |
| `database-adapter` | database | Alternate DB backend implementing the logical schema |
| `database-extension` | database | Extension-owned tables (`ext_<name>_` prefix) alongside core |
| `auth-provider` | auth | Custom authentication / RBAC |
| `rest-extension` | rest | New REST endpoints under a namespaced prefix `/ext/<name>/` |
| `custom-automation` | automations | Downstream automations without editing the built-in registry |
| `open-vocabulary-value` | database | Add a namespaced value to an open vocabulary |

If your integration is a **downstream client** (something that calls the protocol or
REST API rather than living inside the repo), you still declare conformance as a
`rest-consumer` and vendor the contract you depend on.

---

## 3. The contract: how to reference and check against it

### 3a. What the contract governs
`CONTRACT.md` enumerates, per component, **what it owns**, **what it may not own**, and
the exact **interaction surfaces** it may use. Boundaries you cannot cross:

- **Agent → Protocol**: subprocess `ovld protocol <command>`; session key via flag/env;
  required sequence `attach → (update|heartbeat)* → (ask|deliver)` returning JSON stdout.
- **Connector → Protocol**: hook scripts (`UserPromptSubmit`, `PermissionRequest`,
  `Stop`) via `ovld protocol hook-event`. **Hooks must never write the database
  directly** — only `ovld protocol hook-event` / `ovld protocol update`. Edit-file
  capture writes normalized absolute paths to a per-session log, not the DB.
- **CLI → REST**, **REST → Database**, **MCP → Service**, **Auth → Database**, etc. are
  each single sanctioned paths. No component reaches into another's internals or tables.
- **Shared deterministic algorithm**: per-mission branch/worktree planning must produce
  identical output in `cli/src/branch-planning.ts` (prepares) and the backend copy
  (predicts). Both must pass the golden vectors in
  `contract/branch-planning-vectors.json`. Changing it requires regenerating the fixture
  and bumping the contract version.

### 3b. Reference the machine-readable files
Before writing code, read the relevant file — do not guess allowed values:

- `contract/components.yaml` — component registry, capabilities, interfaces.
- `contract/protocol-commands.yaml` — protocol command names, required flags, response
  versions. Check here before relying on any `ovld protocol` flag.
- `contract/extension-points.yaml` — sanctioned points, **approved capability flags**,
  open/closed vocabularies.
- `contract/conformance-manifest.schema.yaml` — the schema your manifest is validated
  against.
- `contract/examples/` — worked example manifests (connector + extension) to copy.

### 3c. Every shipped component needs a conformance manifest
Connectors, extensions, adapters, servers, and downstream consumers must ship a
`conformance-manifest.yaml` and pass:

```bash
ovld contract check <path-to>/conformance-manifest.yaml
```

`ovld contract check` validates the manifest against
`contract/conformance-manifest.schema.yaml`: correct `contractVersion`, a valid
`componentType`, only **approved** capability flags, and **declared** vocabulary
extensions. Run it before opening a PR — it is the admission gate for a new integration.

**Manifest shape** (root fields required for all types: `contractVersion`,
`componentType`, `componentKey` matching `^[a-z][a-z0-9_-]*$`, `label`; `description`
optional). `componentType` enum:

```
connector | extension | database-adapter | auth-provider |
rest-module | rest-consumer | desktop-shell | mcp-server
```

Each type adds a required section (e.g. `connector:` with `agentIdentifier` +
`capabilities`; `extension:` with `tablePrefix` `^ext_[a-z][a-z0-9_]*_$` +
`migrationComponent` `^ext:[a-z...]`; `rest-module:` with `endpointPrefix`
`^/ext/[a-z...]`; `rest-consumer:` with `authMechanisms`, `vendoredContractPath`,
`endpoints`, `exportedTypes`). Any type may add a `vocabularyExtensions` array of
`{ vocabulary, value, description? }` where `value` is namespaced (reverse-DNS or
package-style, e.g. `com.example.custom-artifact`).

### 3d. When you must update the contract (not just conform)
Bump the version and edit `CONTRACT.md` + `contract/components.yaml` **before** code when
you: add a component, interaction surface, protocol command, or core table; change a
protocol command's flags (breaking = version bump); add a **closed**-vocabulary value; or
add a new extension point / connector capability flag. Procedure: read current contract →
draft changes → increment version in the doc header and `contract/components.yaml` → add a
changelog entry → implement → confirm `ovld contract check` passes.

---

## 4. Vocabularies (know closed vs open before you add a value)

**Closed** vocabularies — adding a value requires a **contract version bump**:

- Objective states: `future, draft, submitted, launching, executing, pending_delivery, complete`
- Execution request status: `queued, claimed, launching, launched, failed, cleared, cancelled, expired`
- Mission event types: `update, user_follow_up, alert, decision, ask, permission_request, delivery, execution_requested, awaiting_approval, status_change`
- Core RBAC roles: `ADMIN, MANAGER, MEMBER, PUBLIC`

**Open** vocabularies — extensions add **namespaced** values (declared in your manifest,
no version bump): `workspaces.kind`, `users.kind`, `execution_targets.type`,
`project_resources.type`, `artifacts.type`, `mission_events.source`,
`entity_changes.entity_type` / `.source`, `outbox_messages.topic`, `worker_jobs.type`,
`rbac.permission_names`, `connector.agent_identifiers`,
`webhook_subscriptions.event_types_json`.

---

## 5. Building an agent connector (the common path)

A connector lets a coding harness drive the `ovld protocol` and read mission context in
its own environment. The framework has four layers:

1. **Connector Core** — base Markdown workflow instructions shared by all plugins
   (`connectors/core/`), marked with `<!-- @connector-core -->`.
2. **Connector Plugin** — harness-specific Markdown extending the core.
3. **Plugin Adapter** — idempotent install glue using the harness's native plugin
   manager; must be detectable as stale/missing by `ovld doctor`.
4. **Prompt Wrapper** — optional; prepends mission context at LLM submission.

### Files to add under `connectors/adapters/<agent-name>/`
- `conformance-manifest.yaml` — declares `agentIdentifier` and only **approved**
  capabilities/hooks (see §3c and the capability list below).
- `README.md` — documents launch flags, slash commands, and managed files.
- `hooks/` — hook scripts (e.g. `user-prompt-submit.sh`). Hooks call
  `ovld protocol hook-event` / `ovld protocol update` — **never the database**.
- Connector plugin Markdown extending the core; a prompt wrapper if needed.

**Approved connector capability flags** (closed set — you may only declare these):
```
followUpHook  permissionHook  stopHook  nativeResume  modelFlag
effortFlag    contextFilePrompt  permissionRules  slashCommands
```
**Hook types**: `UserPromptSubmit`, `PermissionRequest`, `Stop`.

### Example manifest (Claude Code connector, from `contract/examples/`)
```yaml
contractVersion: "0"
componentType: connector
componentKey: claude
label: "Claude Code Connector"
description: "Connector adapter for Anthropic Claude Code CLI agent"

connector:
  agentIdentifier: claude
  capabilities:
    - followUpHook
    - permissionHook
    - stopHook
    - modelFlag
    - effortFlag
    - contextFilePrompt
    - permissionRules
    - slashCommands
  hookTypes:
    - UserPromptSubmit
    - PermissionRequest
    - Stop
  installPath: "~/.claude"
  managedFiles:
    - "~/.claude/plugins/overlord/overlord-mission.md"
    - "~/.claude/settings.json"
```

### Validate and finish
```bash
ovld contract check connectors/adapters/<agent-name>/conformance-manifest.yaml
ovld agent-setup <agent>     # install/refresh: claude | codex | cursor | all
ovld doctor                  # verify managed-file integrity + permissions
yarn connectors:version:bump # bump connector version after edits (see connector-versions skill)
```

---

## 6. The protocol lifecycle your integration must drive

Any agent integration follows the same session lifecycle (implemented in `cli/`, invoked
as `ovld protocol <command>`):

```
attach → (update | heartbeat)* → (ask | deliver)
```

- **attach** `--mission-id <id>` — begins a session; returns JSON on stdout including
  `session.sessionKey` (auto-persisted per working directory). In a git workspace it also
  records a checkpoint and a VCS baseline for change detection.
- **update** `--session-key --mission-id --summary --phase` — progress events.
  Phases: `draft, execute, review, deliver, complete, blocked, cancelled`.
- **heartbeat** — liveness ping with no event, for long mechanical stretches.
- **ask** — post a blocking question and stop.
- **deliver** — concluding step; supply one **change rationale** per meaningful file you
  changed. Rationale fields (exact names): `file_path`, `label`, `summary`, `why`,
  `impact` (+ optional `hunks`). Changed files are detected automatically (baseline at
  attach vs `git status` at deliver); you supply only the rationale. Use `--no-file-changes`
  if nothing changed. Never revert another agent's concurrent changes to make delivery
  pass — use `--skip-rationale-for-*` for paths you did not touch.

Confirm command names, flags, and response versions against
`contract/protocol-commands.yaml` rather than memory — the protocol is versioned.

---

## 7. Checklist before you ship an integration

- [ ] Read `CONTRACT.md` for the boundary you cross; update it (+ version bump) if you add
      a surface/command/table/closed-vocabulary value **before** writing code.
- [ ] Chose a sanctioned extension point (§2); interact only through its declared surface.
- [ ] Added a `conformance-manifest.yaml` with the right `componentType` and only
      **approved** capabilities / **declared** vocabulary extensions.
- [ ] `ovld contract check <manifest>` passes.
- [ ] Used namespaced identifiers (tables `ext_<name>_`, REST `/ext/<name>/`, JSON keys,
      event types, vocab values).
- [ ] Hooks/adapters never write the DB directly; adapters are idempotent and
      `ovld doctor`-detectable.
- [ ] For connectors: `ovld agent-setup <agent>` and `ovld doctor` verified; connector
      version bumped.
- [ ] Reviewed `TEST_PLAN.md` and the relevant `<module>/docs/testing.md`.

---

## 8. Quick reference — where to look

- Overall map & dev commands → `README.md`
- The rules → `CONTRACT.md` + `contract/*.yaml`
- Allowed capabilities / vocabularies → `contract/extension-points.yaml`
- Manifest schema → `contract/conformance-manifest.schema.yaml`
- Worked manifests → `contract/examples/`
- Connector how-to → `connectors/README.md`, `connectors/AGENTS.md`, `connectors/adapters/*`
- Protocol commands → `contract/protocol-commands.yaml`, `cli/`
- Validate a component → `ovld contract check <manifest>`
- Doc index & tests → `docs/README.md`, `TEST_PLAN.md`, `<module>/docs/`
