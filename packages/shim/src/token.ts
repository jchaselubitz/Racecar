/**
 * Per-sandbox shim-token authentication.
 *
 * The sandbox's preview URL is private-by-default — Daytona's proxy already
 * turns away unauthenticated upgrades — but the shim does not rely on the proxy
 * alone: it verifies a Racecar-owned token on every connection. That keeps auth
 * a property the control plane owns and can rotate, and it fails closed even if a
 * sandbox is ever exposed without the proxy in front.
 *
 * A client may present the token three ways, mirroring the proxy's own paths so
 * programmatic, browser, and hand-off clients are all served:
 *   - the `x-racecar-shim-token` request header (programmatic clients),
 *   - a `?racecar_token=` query param (browsers, which cannot set WS headers),
 *   - a `racecar-shim-token.<token>` WebSocket subprotocol (browsers again).
 */
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { SHIM_SUBPROTOCOL_PREFIX, SHIM_TOKEN_HEADER, SHIM_TOKEN_QUERY_PARAM } from './contract.js';

/** Compare two tokens in constant time, avoiding a length-leaking early return. */
export function tokensMatch(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    // Still do a comparison against a same-length buffer so timing does not
    // reveal the expected length; the length check itself decides the result.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Pull a presented shim token out of an incoming upgrade request, checking the
 * header, then the query param, then the subprotocol. Returns `undefined` when
 * the client presented none.
 */
export function extractToken(request: IncomingMessage): string | undefined {
  const header = request.headers[SHIM_TOKEN_HEADER];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header[0] !== undefined && header[0].length > 0) return header[0];

  const url = request.url ?? '';
  const query = new URLSearchParams(url.includes('?') ? url.slice(url.indexOf('?') + 1) : '');
  const fromQuery = query.get(SHIM_TOKEN_QUERY_PARAM);
  if (fromQuery !== null && fromQuery.length > 0) return fromQuery;

  const protocols = request.headers['sec-websocket-protocol'];
  const raw = Array.isArray(protocols) ? protocols.join(',') : protocols;
  if (typeof raw === 'string') {
    for (const entry of raw.split(',').map((part) => part.trim())) {
      if (entry.startsWith(SHIM_SUBPROTOCOL_PREFIX)) {
        const token = entry.slice(SHIM_SUBPROTOCOL_PREFIX.length);
        if (token.length > 0) return token;
      }
    }
  }
  return undefined;
}

/** Outcome of {@link authenticate}. */
export type AuthResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: 'missing' | 'invalid' };

/** Verify an upgrade request against the expected per-sandbox token. */
export function authenticate(request: IncomingMessage, expected: string): AuthResult {
  const provided = extractToken(request);
  if (provided === undefined) return { ok: false, reason: 'missing' };
  if (!tokensMatch(expected, provided)) return { ok: false, reason: 'invalid' };
  return { ok: true };
}

/**
 * If the client offered a `racecar-shim-token.<token>` subprotocol, return it so
 * the server can echo it back in the handshake (a browser WebSocket requires the
 * server to accept the subprotocol it proposed). Returns `undefined` otherwise.
 */
export function tokenSubprotocol(request: IncomingMessage): string | undefined {
  const protocols = request.headers['sec-websocket-protocol'];
  const raw = Array.isArray(protocols) ? protocols.join(',') : protocols;
  if (typeof raw !== 'string') return undefined;
  for (const entry of raw.split(',').map((part) => part.trim())) {
    if (entry.startsWith(SHIM_SUBPROTOCOL_PREFIX)) return entry;
  }
  return undefined;
}
