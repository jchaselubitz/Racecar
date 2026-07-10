/**
 * @racecar/core — control-plane domain model and provider adapters.
 *
 * Public surface:
 *  - domain model: {@link Project}, {@link Snapshot}, {@link Sandbox}, {@link Run}
 *    and the lifecycle policy that governs them.
 *  - labels: the self-describing-sandbox label schema (encode/decode/validate).
 *  - provider: the {@link SandboxProvider} adapter interface and its Daytona
 *    implementation.
 *  - credentials: the local encrypted credential store, output redaction, and
 *    injection of stored credentials into a sandbox at creation.
 *  - tmux: the named per-sandbox multiplex session, its snapshot bootstrap, and
 *    the pane-activity classification `racecar attach`/`racecar ps` build on.
 *
 * The in-memory provider test double lives at `@racecar/core/testing`.
 */

/** Package identifier, useful for diagnostics and version banners. */
export const CORE_PACKAGE = '@racecar/core';

export * from './credentials/index.js';
export * from './domain/index.js';
export * from './labels/index.js';
export * from './provider/index.js';
export * from './run/index.js';
export * from './shim/index.js';
export * from './tmux/index.js';
