# Project Sandboxes Proposal

## Recommendation

Do not make every mission start from a brand-new blank environment. Make every project define one or more sandbox blueprints, then give each active mission a stateful sandbox instance created from the selected blueprint when the selected execution target is a sandbox target.

The durable model should be:

1. Project blueprint: immutable or versioned environment template with OS, agent CLIs, package managers, common services, dependency caches, and project bootstrap steps.
2. Mission sandbox: stateful compute instance for one mission, reused across that mission objectives, stopped or paused between objectives, and destroyed or archived by policy.
3. Mission branch/worktree: durable code output. Git remains the source of truth, not the sandbox filesystem.
4. Execution request: still the queue boundary. The runner claims an objective, ensures the mission sandbox exists and is ready, launches the agent inside it, streams logs and terminal state, then marks launch state through the existing protocol.

This keeps the existing Overlord model intact. A Daytona sandbox should be a new execution target capability, not a separate product concept that bypasses execution targets.

## Answer to the package install question

Use lockfile-keyed warm environments, not per-mission installs.

A practical flow:

1. Each project has a default snapshot or blueprint such as overlord-main-node22-supabase-yarn4.
2. The blueprint bakes in slow, stable layers: system packages, Node, Bun or Yarn, Supabase CLI, Docker images if needed, browser tooling, agent CLIs, and package-manager caches.
3. A project environment version is keyed by repo URL plus package manager plus lockfile hashes. Example: projectId + yarn.lock hash + package.json workspace graph hash + Dockerfile hash.
4. On mission launch, create or resume the mission sandbox from the latest compatible environment version.
5. Always git fetch and checkout the mission branch or requested base branch at launch so source is current.
6. Run a cheap dependency verification step such as yarn install --immutable or pnpm install --frozen-lockfile. If the lockfile hash matches the blueprint, this should be fast. If it changed, install once in the sandbox and asynchronously build or promote a new project blueprint for future missions.
7. Start Supabase, Next.js, and other services only while the objective is active. On completion, stop or pause the sandbox instead of leaving all project servers running.

So the answer is yes: every mission can get an isolated sandbox with packages already warm, while each launch still pulls current code. The trick is to cache environment layers by dependency inputs and keep code freshness separate from environment freshness.

## Product model

Add a project setting named something like Execution Environment with options:

- Local machine: current local runner behavior.
- Cloud computer: durable managed runner for a user or workspace.
- Mission sandbox: one stateful sandbox per active mission, created from a project blueprint.

For sandboxes, expose these choices when queueing a run:

- Blueprint: default project blueprint, named custom blueprint, or latest from branch.
- Persistence: delete after delivery, keep for review, keep until manually archived.
- Size: small, medium, large, GPU where provider supports it.
- Access: agent-only, owner can open terminal, org members can view terminal, time-limited preview links.

The mission detail page should show sandbox state: creating, starting, ready, running objective, stopping, stopped, paused, error, archived. Actions should include Open terminal, Open preview, View logs, Stop, Resume, Snapshot, Rebuild from blueprint, and Destroy.

Mobile matters here. The phone should not try to host the environment. It should control and inspect it: start a run, watch the terminal/log stream, open signed previews, approve permission requests, and stop or resume the sandbox.

## Architecture

Keep the runner contract as the center of gravity.

1. Add cloud_sandbox as an execution target type or capability.
2. Add provider-neutral records for sandbox blueprints and mission sandbox instances. Store provider, provider sandbox id, lifecycle state, region, resource size, source snapshot id, TTL policy, terminal URL state, preview metadata, and last activity.
3. Add a sandbox provider adapter boundary: create, start, stop, pause or resume where supported, delete, snapshot, get terminal URL, get preview URL, run command, stream logs.
4. Have the backend or a worker provision the sandbox, then run the normal ovld runner or a focused ovld launch inside that sandbox with injected backend URL, service token, mission id, objective id, and execution request id.
5. The sandbox runner should call the same claim, launching, launched, failed, attach, update, deliver APIs as local runners. Avoid a second execution state machine.
6. Terminal streaming can start provider-native for Daytona, then move behind an Overlord audited PTY gateway if permissions, replay, and mobile embedding need tighter control.
7. Previews should be represented as first-class mission resources with expiration, visibility, and revocation state.

Daytona lines up well with this shape: its docs describe sandboxes as isolated full computers with dedicated filesystem, network, CPU, memory, and disk; snapshots as reusable templates for dependencies and project setup; web terminal access for started sandboxes; preview URLs for sandbox services; and auto-stop lifecycle behavior. Relevant docs: [https://www.daytona.io/docs/en/sandboxes/](https://www.daytona.io/docs/en/sandboxes/) , [https://www.daytona.io/docs/en/snapshots/](https://www.daytona.io/docs/en/snapshots/) , [https://www.daytona.io/docs/en/web-terminal/](https://www.daytona.io/docs/en/web-terminal/) , [https://www.daytona.io/docs/en/preview/](https://www.daytona.io/docs/en/preview/) .

## Important questions

- Is sandbox isolation per mission, per objective, per user, or per project? My recommendation is per active mission for sandbox targets, reused across objectives.
- What is the durable source of truth for unfinished work: Git branch only, sandbox filesystem, or both? Recommendation: Git branch plus protocol artifacts; sandbox filesystem is recoverable but not authoritative.
- Should mission delivery automatically stop, pause, archive, or snapshot the sandbox? Recommendation: stop by default, keep for review for a short TTL, delete after merge or explicit approval.
- Which project setup belongs in a blueprint and which belongs in launch scripts? Stable toolchains and dependency caches belong in blueprints; code pull, migrations, env validation, and dev server start belong at launch.
- How are secrets injected? Recommendation: short-lived scoped secrets at sandbox start, never baked into snapshots.
- How are Git credentials handled for private repos and pushes? Need a scoped deploy key or user-authorized token model with audit records.
- How do we cap cost and CPU? Need org quotas, per-project default size, auto-stop, max runtime, max retained sandboxes, and visible cost estimates before Run.
- Do users need a full GUI browser or only HTTP previews and terminal? Baseline should be headless plus previews. GUI or VNC should be a later capability flag, not the default.
- How should Supabase local databases persist? Decide whether database state is disposable per mission, snapshotted for review, or restored from seed and migrations on each launch.
- Can multiple objectives run concurrently in the same mission sandbox? Recommendation: no by default. One active execution per mission sandbox unless explicitly forked.



## Suggested build sequence

1. Contract first: document cloud_sandbox, sandbox blueprint, mission sandbox instance, lifecycle states, and provider capability flags.
2. Runner foundation: finish headless runner service mode, tmux/log capture, target heartbeat, target-scoped resources, and reliable claim/launch/fail handling.
3. Sandbox MVP: Daytona adapter that creates a sandbox from a project blueprint, injects repo/backend credentials, launches one objective, streams logs, and stops on delivery.
4. UX MVP: project environment settings, run target selector, mission sandbox status card, terminal/log viewer, preview links, and stop/resume controls in web and mobile.
5. Warm environment automation: lockfile-hash blueprint builds, cache invalidation, async rebuild after dependency changes, and a manual Rebuild environment button.
6. Hardening: quotas, audit logs, secret rotation, preview revocation, stuck sandbox cleanup, provider failover, and recovery from agent or provider crashes.



## Key decision

The best mental model is not AgentPod versus execution targets. It is execution targets with a provisioner. A local laptop target already exists. A Daytona target is an execution target whose resource directory and runner are created just in time from a project blueprint, scoped to a mission, then stopped or archived when the objective completes.