import { describe, expect, it, vi } from 'vitest';
import { JsonRpcErrorCode, JsonRpcPeer, RpcError } from './jsonrpc.js';

/** Wire two peers together so each receives what the other sends. */
function link(): { a: JsonRpcPeer; b: JsonRpcPeer } {
  const peers: { a?: JsonRpcPeer; b?: JsonRpcPeer } = {};
  peers.a = new JsonRpcPeer((m) => void peers.b!.receive(m));
  peers.b = new JsonRpcPeer((m) => void peers.a!.receive(m));
  return { a: peers.a, b: peers.b };
}

describe('JsonRpcPeer requests', () => {
  it('resolves a request with the handler result', async () => {
    const { a, b } = link();
    b.onRequest('add', (params) => {
      const { x, y } = params as { x: number; y: number };
      return x + y;
    });
    await expect(a.request('add', { x: 2, y: 3 })).resolves.toBe(5);
  });

  it('rejects with a method-not-found error for an unknown method', async () => {
    const { a } = link();
    await expect(a.request('nope')).rejects.toMatchObject({
      code: JsonRpcErrorCode.methodNotFound,
    });
  });

  it('propagates a thrown handler error as an internal error', async () => {
    const { a, b } = link();
    b.onRequest('boom', () => {
      throw new Error('kaboom');
    });
    await expect(a.request('boom')).rejects.toMatchObject({
      code: JsonRpcErrorCode.internalError,
      message: 'kaboom',
    });
  });

  it('preserves an RpcError code and data thrown by a handler', async () => {
    const { a, b } = link();
    b.onRequest('bad', () => {
      throw new RpcError({ code: -32001, message: 'custom', data: { hint: 'x' } });
    });
    await expect(a.request('bad')).rejects.toMatchObject({ code: -32001, data: { hint: 'x' } });
  });

  it('correlates concurrent requests to their own results', async () => {
    const { a, b } = link();
    b.onRequest('echo', (params) => params);
    const [one, two, three] = await Promise.all([
      a.request('echo', 1),
      a.request('echo', 2),
      a.request('echo', 3),
    ]);
    expect([one, two, three]).toEqual([1, 2, 3]);
  });
});

describe('JsonRpcPeer notifications', () => {
  it('delivers a notification with no reply', async () => {
    const { a, b } = link();
    const handler = vi.fn();
    b.onNotification('ping', handler);
    a.notify('ping', { n: 1 });
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith({ n: 1 });
  });

  it('ignores an unknown notification without erroring', async () => {
    const { a } = link();
    const send = vi.fn();
    const peer = new JsonRpcPeer(send);
    await peer.receive(JSON.stringify({ jsonrpc: '2.0', method: 'unknown' }));
    expect(send).not.toHaveBeenCalled();
    a.notify('also-unknown'); // does not throw
  });
});

describe('JsonRpcPeer framing errors', () => {
  it('returns a parse error for malformed JSON', async () => {
    const sent: string[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m));
    await peer.receive('{not json');
    expect(JSON.parse(sent[0]!)).toMatchObject({
      error: { code: JsonRpcErrorCode.parseError },
      id: null,
    });
  });

  it('returns an invalid-request error for a request with no method', async () => {
    const sent: string[] = [];
    const peer = new JsonRpcPeer((m) => sent.push(m));
    await peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 7 }));
    expect(JSON.parse(sent[0]!)).toMatchObject({
      id: 7,
      error: { code: JsonRpcErrorCode.invalidRequest },
    });
  });
});

describe('JsonRpcPeer close', () => {
  it('rejects in-flight requests and refuses new ones', async () => {
    const peer = new JsonRpcPeer(() => {});
    const pending = peer.request('slow');
    peer.close('gone');
    await expect(pending).rejects.toThrow('gone');
    await expect(peer.request('again')).rejects.toThrow('closed');
  });
});
