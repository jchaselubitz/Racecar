import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * Persistent marker written into `RACECAR_GATEWAY_STATE_DIR` on the first boot
 * and re-read on every subsequent boot. Because it lives beside the gateway's
 * request map and the `.racecar` project/Overlord state, its survival is an
 * empirical proof that the state directory is backed by durable storage: if a
 * Railway redeploy (or any restart) comes up and the marker is gone, the volume
 * did not persist and prior project/Overlord state was lost with it.
 */
export interface PersistenceMarker {
  readonly version: 1;
  /**
   * Device fingerprint that first initialised this directory. A later boot with
   * a different fingerprint means the stable target identity changed, which the
   * gateway docs forbid — surfaced as a warning rather than silently accepted.
   */
  readonly deviceFingerprint: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Number of times the gateway has booted against this surviving directory. */
  readonly bootCount: number;
  readonly lastInstanceId: string;
}

export interface StateDurabilityResult {
  /** True when a marker from a prior boot survived — the state directory is durable. */
  readonly resumed: boolean;
  readonly marker: PersistenceMarker;
  /** Non-fatal operator-facing warnings (e.g. a possible ephemeral volume). */
  readonly warnings: readonly string[];
}

export interface EnsureDurableStateDirOptions {
  readonly stateDirectory: string;
  readonly deviceFingerprint: string;
  readonly instanceId: string;
  readonly now: () => Date;
  /**
   * Directory the running image/build tree occupies. A container platform such
   * as Railway replaces this tree wholesale on every redeploy, so state kept
   * inside it is guaranteed to be lost. Defaults to the process working
   * directory (the Dockerfile `WORKDIR`, `/app`).
   */
  readonly imageDirectory?: string;
}

const MARKER_RELATIVE_PATH = join('.racecar', 'gateway-state', 'persistence.json');

/**
 * Preflight the gateway state directory for durability before any work is
 * claimed. This is the guard for "project/Overlord information deletes on every
 * gateway update": it fails fast on the deterministic misconfiguration (state
 * kept inside the replaceable image tree) and records/reads a persistence marker
 * so an ephemeral volume is at least loudly visible in the logs after a redeploy.
 */
export async function ensureDurableStateDir(
  options: EnsureDurableStateDirOptions,
): Promise<StateDurabilityResult> {
  const stateDirectory = resolve(options.stateDirectory);
  const imageDirectory = resolve(options.imageDirectory ?? process.cwd());

  assertOutsideImageTree(stateDirectory, imageDirectory);

  const markerPath = join(stateDirectory, MARKER_RELATIVE_PATH);
  await mkdir(dirname(markerPath), { recursive: true });

  const existing = await readMarker(markerPath);
  const nowIso = options.now().toISOString();
  const warnings: string[] = [];

  let marker: PersistenceMarker;
  if (existing === undefined) {
    marker = {
      version: 1,
      deviceFingerprint: options.deviceFingerprint,
      firstSeenAt: nowIso,
      lastSeenAt: nowIso,
      bootCount: 1,
      lastInstanceId: options.instanceId,
    };
  } else {
    if (existing.deviceFingerprint !== options.deviceFingerprint) {
      warnings.push(
        `state directory '${stateDirectory}' was initialised by device fingerprint ` +
          `'${existing.deviceFingerprint}' but this boot uses '${options.deviceFingerprint}'. ` +
          `The device fingerprint must stay stable across restarts and redeploys; a change ` +
          `re-targets Overlord and can double-claim work.`,
      );
    }
    marker = {
      version: 1,
      deviceFingerprint: existing.deviceFingerprint,
      firstSeenAt: existing.firstSeenAt,
      lastSeenAt: nowIso,
      bootCount: existing.bootCount + 1,
      lastInstanceId: options.instanceId,
    };
  }

  await writeMarker(markerPath, marker);

  return { resumed: existing !== undefined, marker, warnings };
}

/**
 * A container platform replaces the whole image/build tree on redeploy, so any
 * state directory nested inside it cannot survive an update. This is the exact
 * failure the operator hit, so it is a hard error rather than a warning.
 */
function assertOutsideImageTree(stateDirectory: string, imageDirectory: string): void {
  const relativePath = relative(imageDirectory, stateDirectory);
  const inside =
    relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
  if (inside) {
    throw new Error(
      `RACECAR_GATEWAY_STATE_DIR ('${stateDirectory}') is inside the gateway image tree ` +
        `('${imageDirectory}'), which is replaced on every redeploy — project and Overlord ` +
        `state kept there is deleted on each update. Point it at a persistent volume mounted ` +
        `outside the image (e.g. a Railway volume at '/data').`,
    );
  }
}

async function readMarker(markerPath: string): Promise<PersistenceMarker | undefined> {
  let raw: string;
  try {
    raw = await readFile(markerPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const parsed = JSON.parse(raw) as PersistenceMarker;
  if (
    parsed.version !== 1 ||
    typeof parsed.deviceFingerprint !== 'string' ||
    typeof parsed.firstSeenAt !== 'string' ||
    typeof parsed.bootCount !== 'number'
  ) {
    throw new Error(`persistence marker '${markerPath}' has an unsupported format`);
  }
  return parsed;
}

async function writeMarker(markerPath: string, marker: PersistenceMarker): Promise<void> {
  const temporary = `${markerPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temporary, markerPath);
}

/** Format the durability result for the gateway's stderr boot log. */
export function describeDurability(result: StateDurabilityResult): string {
  if (result.resumed) {
    return (
      `gateway: resumed persistent state directory (first seen ${result.marker.firstSeenAt}, ` +
      `boot #${result.marker.bootCount})`
    );
  }
  return (
    `gateway: no prior persistence marker found — treating as first boot. If this is a ` +
    `redeploy or restart, RACECAR_GATEWAY_STATE_DIR is not on a persistent volume and prior ` +
    `project/Overlord state was lost.`
  );
}
