/**
 * tmux multiplex plane: the named per-sandbox session, its snapshot bootstrap,
 * the shell snippets the control plane sends, and the pane-activity
 * classification `racecar ps` uses.
 */
export {
  TMUX_SESSION,
  TMUX_SETUP_COMMANDS,
  IDLE_PANE_COMMANDS,
  ensureSessionScript,
  attachSessionScript,
  paneCommandsScript,
  parsePaneActivity,
  agentStatusFromActivity,
} from './tmux.js';
export type { TmuxSessionActivity, AgentStatus } from './tmux.js';
