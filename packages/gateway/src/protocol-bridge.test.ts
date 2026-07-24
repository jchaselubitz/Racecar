import { describe, expect, it } from 'vitest';
import {
  autoApprovePermission,
  changeRationalesForChangedFiles,
  changedFilesFromShimGitStatus,
  deliverySummary,
  porcelainPaths,
  protocolEventForUpdate,
} from './protocol-bridge.js';

describe('protocolEventForUpdate', () => {
  it('turns active tool calls into progress updates', () => {
    expect(
      protocolEventForUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'edit gateway',
        status: 'in_progress',
      }),
    ).toEqual({ command: 'update', text: 'Agent in progress tool: edit gateway' });
  });

  it('uses heartbeats for completed tools and ignores text chunks', () => {
    expect(
      protocolEventForUpdate({
        sessionUpdate: 'tool_call',
        toolCallId: 'tool-1',
        title: 'run tests',
        status: 'completed',
      }),
    ).toEqual({ command: 'heartbeat', text: 'Agent completed tool: run tests' });
    expect(
      protocolEventForUpdate({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'working' },
      }),
    ).toBeUndefined();
  });

  it('maps the explicit Racecar clarification extension to a terminal ask', () => {
    expect(
      protocolEventForUpdate({
        sessionUpdate: 'agent_question',
        question: 'Which deployment environment should I use?',
      }),
    ).toEqual({ command: 'ask', text: 'Which deployment environment should I use?' });
    expect(
      protocolEventForUpdate({ sessionUpdate: 'agent_question', question: '   ' }),
    ).toBeUndefined();
  });
});

describe('autoApprovePermission', () => {
  it('selects an allow option and cancels when no safe option exists', () => {
    expect(
      autoApprovePermission({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: 'write a file' },
        options: [
          { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          { optionId: 'yes', name: 'Allow once', kind: 'allow_once' },
        ],
      }),
    ).toEqual({ outcome: { outcome: 'selected', optionId: 'yes' } });
    expect(
      autoApprovePermission({
        sessionId: 'session-1',
        toolCall: { toolCallId: 'tool-1', title: 'write a file' },
        options: [{ optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      }),
    ).toEqual({ outcome: { outcome: 'cancelled' } });
  });
});

describe('porcelainPaths', () => {
  it('returns current paths and skips rename source records', () => {
    expect(porcelainPaths(' M packages/gateway/src/main.ts\0R  new.ts\0old.ts\0')).toEqual([
      'packages/gateway/src/main.ts',
      'new.ts',
    ]);
  });
});

describe('changedFilesFromShimGitStatus', () => {
  it('uses only the shim turn-end status and preserves its VCS status codes', () => {
    expect(
      changedFilesFromShimGitStatus(' M packages/gateway/src/main.ts\n?? notes.txt\n!! ignored'),
    ).toEqual([
      { filePath: 'packages/gateway/src/main.ts', vcsStatus: ' M' },
      { filePath: 'notes.txt', vcsStatus: '??' },
    ]);
  });

  it('writes a concise terminal summary without deriving a diff elsewhere', () => {
    expect(deliverySummary('end_turn', 1)).toBe(
      'Gateway-delivered ACP turn after end_turn; shim captured 1 changed file.',
    );
  });
});

describe('changeRationalesForChangedFiles', () => {
  it('emits one complete, non-empty rationale per changed file so deliver never lacks coverage', () => {
    const rationales = changeRationalesForChangedFiles(
      [
        { filePath: 'packages/gateway/src/main.ts', vcsStatus: ' M' },
        { filePath: 'notes.txt', vcsStatus: '??' },
      ],
      'coo:270',
    );
    expect(rationales).toHaveLength(2);
    expect(rationales[0]).toMatchObject({ file_path: 'packages/gateway/src/main.ts' });
    for (const rationale of rationales) {
      for (const field of ['file_path', 'label', 'summary', 'why', 'impact'] as const) {
        expect(rationale[field].length).toBeGreaterThan(0);
      }
      expect(rationale.why).toContain('coo:270');
    }
  });

  it('returns nothing when the shim reported no changes', () => {
    expect(changeRationalesForChangedFiles([], 'coo:270')).toEqual([]);
  });
});
