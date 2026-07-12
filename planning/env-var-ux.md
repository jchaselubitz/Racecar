# Env-var UX decision

## Status

Proposed for mission `coo:271` ("need some kind of secret handler"), objective 2:
"what is the best UX for allowing the user to set env vars". Builds directly on
objective 1's accepted posture — secrets are never baked into snapshots; they are
injected per-sandbox at create time from the machine-local encrypted store. See
[`stage0-decision-record.md`](stage0-decision-record.md) for the store's origin and
the `packages/core/src/credentials/` module for its current shape.

This document answers *how the user actually enters and manages* those env vars.

## Finding

Application env vars differ from the two credential kinds the store handles today
(`claude` OAuth token, `git` token) in four ways that drive the UX:

1. **Cardinality.** An app has many env vars (`DATABASE_URL`, `STRIPE_SECRET_KEY`,
   `OPENAI_API_KEY`, `NODE_ENV`, …), not a single token. One-at-a-time `--token`
   entry (`racecar auth claude`) does not scale — the primary path must be **bulk
   import of an existing `.env`**.
2. **Scope.** A Claude/git credential is a property of the *operator* and is reused
   across every project, so the store is machine-global (`~/.racecar`,
   `packages/cli/src/credentials.ts`). App env is a property of the *project* —
   `DATABASE_URL` is different for each repo. The UX therefore needs a **project
   dimension** that the operator credentials do not.
3. **Mixed sensitivity.** Some vars are true secrets (`STRIPE_SECRET_KEY`); some are
   plain config (`NODE_ENV=production`, `PORT=3000`). The store's model treats every
   value in `StoredCredential.secrets` as secret and redacts it everywhere
   (`store.secrets()` seeds the `Redactor`). Redacting `production` globally is
   harmless but noisy.
4. **Familiar mental model.** Developers already keep these in a local `.env`. The
   best UX meets them there and imports it, rather than inventing a new entry ritual.

The good news: the injection seam already fits. `buildCredentialInjection()`
(`packages/core/src/credentials/injection.ts`) already returns `{ env, setupCommands }`
and its output is merged straight into `createSandbox({ envVars })` at
`packages/cli/src/main.ts:387,395,425`. Any secret placed in the store is *already*
swept into the `Redactor` at `packages/cli/src/credentials.ts:67`. The only gap is
that `buildCredentialInjection` knows just `claude` and `git` kinds.

## Decision

Add a **`racecar env` command family**, project-scoped, backed by the existing
encrypted store, with **`.env` as the import/authoring format**. Do not introduce a
second storage mechanism — reuse `CredentialStore` so redaction and encryption come
for free.

### Command surface

```
# Bulk import — the 90% path. Reads a dotenv file (KEY=VALUE, # comments,
# quotes, tolerant of a leading `export `) and stores every pair at once.
racecar env import --project <p> [--file .env] [--stdin] [--replace]

# Surgical single-var edit. Value comes from --stdin or an interactive prompt
# so it never lands in shell history.
racecar env set <KEY> --project <p> [--stdin]

# Keys only, never values — like `auth list`, plus a fingerprint per value so a
# rotation can be confirmed without revealing the secret.
racecar env list --project <p>
#   KEY                FINGERPRINT   UPDATED
#   DATABASE_URL       a1b2c3d4      2026-07-12
#   STRIPE_SECRET_KEY  e5f6a7b8      2026-07-12

# Removal.
racecar env rm <KEY> --project <p>
racecar env clear --project <p>
```

Design choices, and why:

- **`.env` import is the flagship, not per-var entry.** It matches how developers
  already hold these values and makes a 30-var setup one command. Per-var `set` stays
  for rotating a single key. `.env` is already gitignored — keep it purely as an
  *authoring/import surface*, never the store of record (see rejected options).
- **Values never echoed.** `env list` shows keys + `secretFingerprint()` only,
  mirroring the existing `auth` posture (`packages/cli/src/auth.ts:75,87`). `set`
  reads from stdin/prompt; `import` reads a file or stdin. No secret literal ever
  enters a shell command Racecar runs or logs.
- **Default every imported var to secret (redacted).** Simplest and safest, and it is
  what reusing `secrets` gives us. The only cost is that a value like `production`
  gets redacted in logs — harmless. A later `racecar env set --public KEY` that stores
  into `meta` instead of `secrets` can opt a plain-config var out of redaction; not
  needed for v1.

### Scope model

**Project-scoped is the v1 default.** Store all of a project's vars as one credential
named `env:<project>`, mirroring the existing `git:<host>` naming convention
(`packages/cli/src/auth.ts:84`). This keeps the store's flat name→credential map
intact and makes selection trivial.

Mission/branch-scoped overrides are a deliberate **non-goal for v1**. App env is
stable per project; a mission that needs an override can be layered later by merging a
`env:<project>:<mission>` credential over the project one at injection time. Ship
project scope first; document mission scope as the extension point.

### Implementation seam (small, localized)

1. **New credential kind `env`** in `injection.ts`:
   `envCredential({ project, vars }) → { kind: 'env', secrets: vars, meta: { project } }`.
2. **One branch in `buildCredentialInjection`**, project-filtered so only the current
   project's vars inject (not every project's):
   ```ts
   else if (credential.kind === 'env' && credential.meta?.project === project) {
     Object.assign(env, credential.secrets);
   }
   ```
   `buildCredentialInjection` / `loadCredentialInjection` gain a `project` argument;
   the caller already has `project.name` in scope at `main.ts:387`.
3. **`racecar env` dispatch** in `packages/cli/src/main.ts:1392` alongside `auth`,
   plus a small dotenv parser (`KEY=VALUE`, comments, quotes) — the only genuinely new
   code.
4. **Redaction is automatic** — `store.secrets()` already sweeps every credential's
   `secrets`, so imported values are covered the moment they are stored. No change.

## Rejected alternatives

- **A per-project/per-snapshot `.env` file used directly as the store.** Convenient to
  edit, but unencrypted at rest, one `git add` away from leaking, and outside the
  `Redactor` — values would surface in exec logs. Use `.env` only as an import source.
- **GitHub Secrets for app env.** Right tool for the *gateway/deploy* creds that CI and
  the host consume (`OVERLORD_USER_TOKEN`, `DAYTONA_API_KEY`,
  `RACECAR_GATEWAY_DEVICE_FINGERPRINT`; see `packages/gateway/src/config.ts`), wrong
  scope for per-sandbox app env — it would require an Actions round-trip to reach a
  sandbox and is not machine-local to the operator running `racecar`. Keep the two
  homes split by lifetime (objective 1 decision).
- **Baking env into the snapshot.** Rejected in objective 1: shared image layers,
  survives rotation, sits outside the `Redactor`.

## Open question for the PM

Confirm **project scope** is the right v1 granularity (recommended), or whether a
mission/branch override dimension is needed in the first cut. Everything above assumes
project scope first, mission scope deferred.
