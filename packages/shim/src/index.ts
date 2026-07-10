/**
 * @racecar/shim — the in-sandbox daemon serving ACP over a preview-URL WebSocket.
 *
 * Public surface:
 *  - the wire {@link './contract.js' contract}: port, token env var, and the auth
 *    paths a client uses to present the per-sandbox token;
 *  - the {@link ShimServer}: the authenticated WebSocket endpoint;
 *  - the ACP layer ({@link AcpAgentServer}, the {@link './acp.js' ACP types}) and
 *    the JSON-RPC peer it rides on;
 *  - the southbound {@link Agent} seam and the built-in {@link EchoAgent} stub
 *    that tier-1/tier-2 adapters replace in the next objective;
 *  - {@link startDaemon}, the boot entrypoint.
 */

/** Package identifier, for diagnostics and version banners. */
export const SHIM_PACKAGE = '@racecar/shim';

export * from './contract.js';
export * from './jsonrpc.js';
export * from './acp.js';
export * from './agent.js';
export * from './acp-server.js';
export * from './stdio.js';
export * from './acp-client.js';
export * from './stream-json.js';
export * from './agents.js';
export * from './token.js';
export * from './config.js';
export * from './server.js';
export { runDaemon, startDaemon } from './daemon.js';
