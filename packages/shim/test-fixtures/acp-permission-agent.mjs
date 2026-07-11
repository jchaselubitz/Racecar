#!/usr/bin/env node
/**
 * A minimal ACP agent over stdio that exercises the permission path. On a prompt
 * it issues a `session/request_permission` request back to its client (the shim's
 * ProcessAcpAgent adapter, which forwards it northbound), waits for the selected
 * option, then streams a message naming the choice and ends the turn. Used to
 * prove `racecar chat`'s permission-prompt flow end-to-end through the shim.
 */
import { createInterface } from 'node:readline';

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

let nextId = 1000;
const pending = new Map();

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim().length === 0) return;
  const msg = JSON.parse(line);
  const { id, method, params, result } = msg;

  // A response to our own outbound request (the permission answer).
  if (method === undefined && id !== undefined && pending.has(id)) {
    const resolve = pending.get(id);
    pending.delete(id);
    resolve(result);
    return;
  }

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] },
    });
  } else if (method === 'session/new') {
    send({ jsonrpc: '2.0', id, result: { sessionId: 'perm-session-1' } });
  } else if (method === 'session/prompt') {
    const reqId = nextId++;
    pending.set(reqId, (answer) => {
      const choice =
        answer?.outcome?.outcome === 'selected' ? answer.outcome.optionId : 'cancelled';
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: `decision: ${choice}` },
          },
        },
      });
      send({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
    });
    send({
      jsonrpc: '2.0',
      id: reqId,
      method: 'session/request_permission',
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: 'call-1', title: 'run dangerous command' },
        options: [
          { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
          { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
        ],
      },
    });
  } else if (method === 'session/cancel') {
    // Notification: no reply.
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
