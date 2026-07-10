import { describe, expect, it } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { SHIM_SUBPROTOCOL_PREFIX, SHIM_TOKEN_HEADER, SHIM_TOKEN_QUERY_PARAM } from './contract.js';
import { authenticate, extractToken, tokenSubprotocol, tokensMatch } from './token.js';

/** Minimal fake of the fields {@link extractToken} reads off a request. */
function request(init: {
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
}): IncomingMessage {
  return { url: init.url ?? '/', headers: init.headers ?? {} } as IncomingMessage;
}

describe('tokensMatch', () => {
  it('accepts an exact match and rejects any difference', () => {
    expect(tokensMatch('secret-token', 'secret-token')).toBe(true);
    expect(tokensMatch('secret-token', 'secret-toked')).toBe(false);
    expect(tokensMatch('secret-token', 'secret-token-longer')).toBe(false);
    expect(tokensMatch('secret-token', '')).toBe(false);
  });
});

describe('extractToken', () => {
  it('reads the token from the header', () => {
    expect(extractToken(request({ headers: { [SHIM_TOKEN_HEADER]: 'tok-h' } }))).toBe('tok-h');
  });

  it('reads the token from the query param', () => {
    expect(extractToken(request({ url: `/?${SHIM_TOKEN_QUERY_PARAM}=tok-q` }))).toBe('tok-q');
  });

  it('reads the token from the subprotocol', () => {
    expect(
      extractToken(
        request({ headers: { 'sec-websocket-protocol': `${SHIM_SUBPROTOCOL_PREFIX}tok-s` } }),
      ),
    ).toBe('tok-s');
  });

  it('prefers the header over the query param', () => {
    expect(
      extractToken(
        request({
          url: `/?${SHIM_TOKEN_QUERY_PARAM}=tok-q`,
          headers: { [SHIM_TOKEN_HEADER]: 'tok-h' },
        }),
      ),
    ).toBe('tok-h');
  });

  it('returns undefined when no token is presented', () => {
    expect(extractToken(request({ url: '/', headers: {} }))).toBeUndefined();
  });
});

describe('authenticate', () => {
  it('distinguishes missing, invalid, and valid tokens', () => {
    expect(authenticate(request({}), 'expected')).toEqual({ ok: false, reason: 'missing' });
    expect(
      authenticate(request({ headers: { [SHIM_TOKEN_HEADER]: 'wrong' } }), 'expected'),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(
      authenticate(request({ headers: { [SHIM_TOKEN_HEADER]: 'expected' } }), 'expected'),
    ).toEqual({ ok: true });
  });
});

describe('tokenSubprotocol', () => {
  it('echoes back the exact token subprotocol the client offered', () => {
    const offered = `${SHIM_SUBPROTOCOL_PREFIX}abc`;
    expect(tokenSubprotocol(request({ headers: { 'sec-websocket-protocol': offered } }))).toBe(
      offered,
    );
    expect(tokenSubprotocol(request({}))).toBeUndefined();
  });
});
