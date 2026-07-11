import { describe, expect, it } from 'vitest';
import { LineBuffer, spawnAgentProcess } from './stdio.js';

describe('LineBuffer', () => {
  it('emits complete lines and buffers a partial trailing line', () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push('one\ntw');
    expect(lines).toEqual(['one']);
    buffer.push('o\nthree\n');
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it('reassembles a value split across chunks and skips blank lines', () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push('{"a":');
    buffer.push('1}\n\n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it('flushes a buffered partial line at EOF', () => {
    const lines: string[] = [];
    const buffer = new LineBuffer((line) => lines.push(line));
    buffer.push('no-newline');
    buffer.flush();
    expect(lines).toEqual(['no-newline']);
  });
});

describe('spawnAgentProcess', () => {
  it('round-trips lines through a real child process', async () => {
    // `cat` echoes each stdin line back on stdout: proves spawn + framing + write.
    const proc = spawnAgentProcess({ command: 'cat' });
    const received: string[] = [];
    proc.onLine((line) => received.push(line));
    proc.writeLine('hello');
    proc.writeLine('world');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(received).toEqual(['hello', 'world']);
    proc.kill();
  });

  it('reports a spawn failure through the exit handler', async () => {
    const proc = spawnAgentProcess({ command: 'this-binary-does-not-exist-racecar' });
    const exit = await new Promise<{ code: number | null }>((resolve) => {
      proc.onExit((info) => resolve(info));
    });
    expect(exit.code).toBeNull();
  });
});
