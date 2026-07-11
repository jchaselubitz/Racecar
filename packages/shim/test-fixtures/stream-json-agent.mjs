#!/usr/bin/env node
/**
 * A minimal stream-json agent over stdio, used only by StreamJsonAgent (tier-2)
 * tests to prove the bridge against a real subprocess. It mirrors the shape Claude
 * Code emits under `--output-format stream-json` / accepts under `--input-format
 * stream-json`: it reads a `user` envelope per line and replies with one
 * `assistant` text envelope followed by a terminating `result`. A user text of
 * `BOOM` yields an error result so the bridge's refusal mapping can be asserted.
 */
import { createInterface } from 'node:readline';

function send(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

send({ type: 'system', subtype: 'init' });

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim().length === 0) return;
  const msg = JSON.parse(line);
  if (msg.type !== 'user') return;
  const text = (msg.message?.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (text === 'BOOM') {
    send({ type: 'result', subtype: 'error', is_error: true, result: 'boom' });
    return;
  }
  send({ type: 'assistant', message: { content: [{ type: 'text', text: `echo: ${text}` }] } });
  send({ type: 'result', subtype: 'success', is_error: false, result: `echo: ${text}` });
});
