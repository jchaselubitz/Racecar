#!/usr/bin/env node
/**
 * A minimal ACP agent over stdio, used only by ProcessAcpAgent tests to prove the
 * real-subprocess path (spawn + newline framing + exit) without a real Claude/Codex
 * binary. It speaks the same JSON-RPC 2.0 / ACP subset the shim's adapter drives:
 * initialize (advertising distinctive capabilities the test asserts pass through),
 * session/new, session/prompt (streams one agent_message_chunk, then end_turn).
 */
import { createInterface } from 'node:readline';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim().length === 0) return;
  const msg = JSON.parse(line);
  const { id, method, params } = msg;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: true, audio: false, embeddedContext: true },
        },
        authMethods: [],
      },
    });
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'srv-session-1' } });
  } else if (method === 'session/prompt') {
    const text = (params.prompt ?? [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: params.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: `pong: ${text}` },
        },
      },
    });
    send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  } else if (method === 'session/cancel') {
    // Notification: no reply.
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
