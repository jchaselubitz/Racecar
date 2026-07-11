/**
 * Capturing the run workspace's git state at a turn boundary.
 *
 * Stage 2's tmux run wrapper recorded a git status/diff summary at run end so
 * `racecar runs` could show what a run changed. Now that the shim owns run state,
 * that capture moves here: at each turn's end the registry asks for the working
 * tree's `git status --porcelain` and `git diff --stat`, and stores them on the
 * run. It is injected into the registry ({@link CaptureGit}) so tests need no git;
 * this is the production implementation the daemon supplies.
 */
import { execFile } from 'node:child_process';
import type { GitSummary } from './runs.js';

/** Run one git command in `cwd`, resolving its stdout ('' on any failure). */
function git(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', [...args], { cwd, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error !== null ? '' : stdout);
    });
  });
}

/**
 * Capture the working tree's status and diffstat in `cwd`. A missing cwd or a
 * non-repo yields empty strings rather than throwing — a run without a git
 * workspace simply records no summary.
 */
export async function captureGit(cwd: string | undefined): Promise<GitSummary> {
  if (cwd === undefined || cwd.length === 0) return { gitStatus: '', gitDiffStat: '' };
  const [gitStatus, gitDiffStat] = await Promise.all([
    git(['status', '--porcelain'], cwd),
    git(['diff', '--stat'], cwd),
  ]);
  return { gitStatus, gitDiffStat };
}
