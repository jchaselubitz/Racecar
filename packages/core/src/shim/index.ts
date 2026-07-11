/**
 * The shim control-plane seam: delivering and launching the in-sandbox ACP
 * daemon, and the per-sandbox token contract shared with `@racecar/shim`.
 */
export {
  SHIM_BUNDLE_PATH,
  SHIM_DEFAULT_PORT,
  SHIM_PORT_ENV,
  SHIM_TMUX_SESSION,
  SHIM_TOKEN_ENV,
  SHIM_TOKEN_FILE,
  generateShimToken,
  shimBootScript,
  shimRebootScript,
  shimStatusScript,
  shimTokenScript,
  type ShimBootParams,
  type ShimRebootParams,
} from './launch.js';
