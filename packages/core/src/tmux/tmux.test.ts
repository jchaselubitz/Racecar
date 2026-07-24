import { describe, expect, it } from 'vitest';
import {
  TMUX_SESSION,
  TMUX_SETUP_COMMANDS,
  agentStatusFromActivity,
  attachSessionScript,
  ensureSessionScript,
  paneCommandsScript,
  parsePaneActivity,
} from './tmux.js';

describe('tmux session scripts', () => {
  it('bakes tmux and git into the snapshot recipe', () => {
    expect(TMUX_SETUP_COMMANDS.join('\n')).toContain('apt-get install');
    expect(TMUX_SETUP_COMMANDS.join('\n')).toContain('tmux');
    // git is required for the build-time clone and every runtime fetch/checkout.
    expect(TMUX_SETUP_COMMANDS.join('\n')).toContain('git');
  });

  it('creates the session idempotently and detached', () => {
    const script = ensureSessionScript();
    expect(script).toContain('has-session');
    expect(script).toContain(`new-session -d -s '${TMUX_SESSION}'`);
    expect(script).not.toContain('-c ');
  });

  it('passes a start directory through, single-quoted', () => {
    const script = ensureSessionScript('/home/daytona/work space');
    expect(script).toContain(`-c '/home/daytona/work space'`);
  });

  it('escapes single quotes in interpolated values', () => {
    const script = ensureSessionScript("/tmp/it's here");
    expect(script).toContain("'/tmp/it'\\''s here'");
  });

  it('attaches via new-session -A and execs to replace the shell', () => {
    const script = attachSessionScript('/workspace');
    expect(script).toBe(`exec tmux new-session -A -s '${TMUX_SESSION}' -c '/workspace'`);
  });

  it('lists pane commands tolerant of a missing session', () => {
    const script = paneCommandsScript();
    expect(script).toContain('list-panes');
    expect(script).toContain('pane_current_command');
    expect(script).toContain('|| true');
  });
});

describe('parsePaneActivity', () => {
  it('treats empty output as a nonexistent session', () => {
    const activity = parsePaneActivity('');
    expect(activity.sessionExists).toBe(false);
    expect(activity.agentActive).toBe(false);
    expect(agentStatusFromActivity(activity)).toBe('no-session');
  });

  it('treats a lone shell as an idle session', () => {
    const activity = parsePaneActivity('bash\n');
    expect(activity.sessionExists).toBe(true);
    expect(activity.agentActive).toBe(false);
    expect(agentStatusFromActivity(activity)).toBe('idle');
  });

  it('flags a non-shell foreground command as an active agent', () => {
    const activity = parsePaneActivity('bash\nnode\n');
    expect(activity.paneCommands).toEqual(['bash', 'node']);
    expect(activity.agentActive).toBe(true);
    expect(agentStatusFromActivity(activity)).toBe('active');
  });

  it('ignores blank lines and surrounding whitespace', () => {
    const activity = parsePaneActivity('  bash  \n\n  claude \n');
    expect(activity.paneCommands).toEqual(['bash', 'claude']);
    expect(agentStatusFromActivity(activity)).toBe('active');
  });
});
