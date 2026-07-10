/**
 * The run plane: launching an agent invocation as a supervised Run inside a
 * sandbox's tmux session, and reading back the results it records.
 */
export type { AgentId, AgentSpec } from './agents.js';
export { DEFAULT_AGENT, PROMPT_VAR, knownAgents, resolveAgent } from './agents.js';

export type { RunMeta, RunRecord, LaunchRunParams, LockResult } from './scripts.js';
export {
  acquireLockScript,
  generateRunId,
  launchRunScript,
  parseLockResult,
  parseRunRecords,
  readRunsScript,
  runStatusScript,
  runWrapperScript,
} from './scripts.js';
