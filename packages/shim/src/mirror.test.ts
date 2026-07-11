import { describe, expect, it } from 'vitest';
import type { SessionUpdate } from './acp.js';
import { createTranscriptMirror, renderTranscriptLine, transcriptPath } from './mirror.js';

describe('renderTranscriptLine', () => {
  it('renders each visible update kind and skips the rest', () => {
    expect(
      renderTranscriptLine({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hi' },
      }),
    ).toBe('hi');
    expect(
      renderTranscriptLine({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'do it' },
      }),
    ).toBe('> do it');
    expect(
      renderTranscriptLine({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'hmm' },
      }),
    ).toBe('(thinking) hmm');
    expect(
      renderTranscriptLine({
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        title: 'read file',
        status: 'in_progress',
      }),
    ).toBe('[tool in_progress] read file');
  });
});

describe('createTranscriptMirror', () => {
  it('opens the window once per run and appends every rendered line', () => {
    const windows: string[] = [];
    const appended: { runId: string; line: string }[] = [];
    const mirror = createTranscriptMirror({
      append: (runId, line) => appended.push({ runId, line }),
      ensureWindow: (runId) => windows.push(runId),
    });
    const chunk = (text: string): SessionUpdate => ({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text },
    });
    mirror('run-1', chunk('a'));
    mirror('run-1', chunk('b'));
    expect(windows).toEqual(['run-1']); // window opened exactly once
    expect(appended).toEqual([
      { runId: 'run-1', line: 'a' },
      { runId: 'run-1', line: 'b' },
    ]);
  });

  it('ignores updates that render to nothing', () => {
    let windowed = false;
    const mirror = createTranscriptMirror({
      append: () => {},
      ensureWindow: () => {
        windowed = true;
      },
    });
    // A tool_call renders, but an unknown/empty update should not open a window.
    mirror('run-1', {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image' },
    } as unknown as SessionUpdate);
    expect(windowed).toBe(false);
  });
});

describe('transcriptPath', () => {
  it('is under the run state dir', () => {
    expect(transcriptPath('/home/x', 'run-9')).toBe('/home/x/.racecar/runs/run-9.transcript');
  });
});
