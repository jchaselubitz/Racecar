import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connectShim, type ShimConnection } from 'racecar-cli/shim-connect';
import {
  DaytonaProvider,
  RetryingProvider,
  sandboxLabelSelector,
  toSandboxes,
} from '@racecar/core';
import { textBlocks } from '@racecar/shim';
import type { AcpClientHandlers, PromptResponse, SessionSummary } from '@racecar/shim';
import type { Project, Sandbox, SandboxProvider } from '@racecar/core';
import type { RunnerClaim } from './overlord-runner-contract.js';
import {
  claimBranchName,
  fetchMissionBranch,
  resolveSandboxLaunch,
  type GatewayBranchStrategy,
  type MissionBranchInfo,
  type ResolvedSandboxLaunch,
} from './sandbox-launch.js';

const exec = promisify(execFile);

// `RunnerClaim` is vendored in ./overlord-runner-contract.ts (the manifest's
// declared vendored contract); re-export it so existing importers keep their
// `./launch-adapter.js` path.
export type { RunnerClaim } from './overlord-runner-contract.js';
export type {
  GatewayBranchStrategy,
  ResolvedSandboxLaunch,
  SandboxLaunchMode,
} from './sandbox-launch.js';
export { claimBranchName as claimBranch } from './sandbox-launch.js';

export interface ShimLaunch {
  readonly project: Project;
  readonly branch: string;
  readonly sandbox: Sandbox;
  readonly connection: ShimConnection;
  readonly sessionId: string;
  /** Resolves when the shim-owned ACP turn stops. */
  readonly turn: Promise<PromptResponse>;
}

/** A sandbox selected and started, ready for an ACP session to be opened. */
export interface PreparedShimLaunch {
  readonly claim: RunnerClaim;
  readonly project: Project;
  /** Resource selected from Overlord's registered fixed working directory. */
  readonly resourceKey: string;
  readonly branch: string;
  /** How this claim was placed into a sandbox (mission-scoped vs shared). */
  readonly launch: ResolvedSandboxLaunch;
  /** The selected resource's fixed path inside this project's snapshot. */
  readonly workspaceDir: string;
  readonly sandbox: Sandbox;
}

/** A session opened through the shim but not prompted yet. */
export interface OpenShimLaunch extends PreparedShimLaunch {
  readonly connection: ShimConnection;
  readonly sessionId: string;
}

/** A previously-created shim session reconnected after a gateway restart. */
export interface ResumedShimLaunch extends OpenShimLaunch {
  readonly summary: SessionSummary;
}

export interface LaunchAdapterOptions {
  readonly provider: SandboxProvider;
  /** Racecar state directory root; defaults to the gateway process directory. */
  readonly stateDirectory?: string;
  /**
   * Overlord REST credentials used to read `mission.branch` when the claim does
   * not name an explicit sandbox launch mode. Optional in tests.
   */
  readonly overlord?: {
    readonly backendUrl: string;
    readonly token: string;
    readonly deviceFingerprint?: string;
  };
  /**
   * Gateway-wide branching policy. When set, every claim is placed by this
   * policy (overriding Overlord's per-mission `mission.branch`) unless the claim
   * names an explicit launch mode. See {@link GatewayBranchStrategy}.
   */
  readonly branchStrategy?: GatewayBranchStrategy;
  /** Branch name for the `shared` strategy; defaults to the base branch. */
  readonly sharedBranch?: string;
  /** Injectable for tests — bypasses the Overlord mission fetch. */
  readonly loadMissionBranch?: (claim: RunnerClaim) => Promise<MissionBranchInfo | undefined>;
  /** Injectable for tests and for deployments where the CLI has another path. */
  readonly createSandbox?: (options: {
    project: Project;
    sandboxMission: string;
    branch: string;
    baseBranch: string;
    scope: 'mission' | 'project';
  }) => Promise<Sandbox>;
}

/**
 * Starts an Overlord-originated request in a Racecar sandbox without ever
 * spawning an agent process in the gateway. The ACP shim remains the sole
 * owner of the agent session.
 *
 * The durable gateway-state store owns request-to-session idempotency. This
 * adapter exposes both fresh and resumed ACP connections while always
 * preferring an existing matching car. Sandbox placement follows
 * {@link resolveSandboxLaunch}: mission-scoped (one sandbox per mission) or
 * project-scoped (one shared sandbox per project/branch).
 */
export class ShimLaunchAdapter {
  readonly #provider: SandboxProvider;
  readonly #stateDirectory: string;
  readonly #overlord: LaunchAdapterOptions['overlord'];
  readonly #loadMissionBranch?: LaunchAdapterOptions['loadMissionBranch'];
  readonly #branchStrategy: GatewayBranchStrategy | undefined;
  readonly #sharedBranch: string | undefined;
  readonly #createSandbox: NonNullable<LaunchAdapterOptions['createSandbox']>;

  constructor(options: LaunchAdapterOptions) {
    this.#provider = options.provider;
    this.#stateDirectory = options.stateDirectory ?? process.cwd();
    this.#overlord = options.overlord;
    this.#loadMissionBranch = options.loadMissionBranch;
    this.#branchStrategy = options.branchStrategy;
    this.#sharedBranch = options.sharedBranch;
    this.#createSandbox =
      options.createSandbox ??
      ((args) =>
        createSandboxViaCli({
          provider: this.#provider,
          project: args.project,
          sandboxMission: args.sandboxMission,
          branch: args.branch,
          baseBranch: args.baseBranch,
          scope: args.scope,
          cwd: this.#stateDirectory,
        }));
  }

  async prepare(claim: RunnerClaim): Promise<PreparedShimLaunch> {
    const target = await resolveProjectResource(claim, this.#stateDirectory);
    const { project } = target;
    const missionBranch = await this.#missionBranchFor(claim);
    const launch = resolveSandboxLaunch({
      claim,
      project,
      ...(missionBranch !== undefined ? { missionBranch } : {}),
      ...this.#strategyOptions(),
    });
    const sandbox = await this.#findOrCreateSandbox({ project, launch });
    await ensureStarted(this.#provider, sandbox);
    return {
      claim,
      project,
      resourceKey: target.resourceKey,
      branch: launch.branch,
      launch,
      workspaceDir: target.workspaceDir,
      sandbox,
    };
  }

  async open(prepared: PreparedShimLaunch, handlers: AcpClientHandlers): Promise<OpenShimLaunch> {
    const connection = await connectShim(this.#provider, prepared.sandbox.id, { handlers });
    try {
      await connection.client.initialize();
      const sessionId = await connection.client.newSession({ cwd: prepared.workspaceDir });
      return { ...prepared, connection, sessionId };
    } catch (error) {
      connection.close();
      await connection.closed.catch(() => {});
      throw error;
    }
  }

  /** Reconnect to a durable shim session rather than opening a second run. */
  async resume(
    prepared: PreparedShimLaunch,
    sessionId: string,
    handlers: AcpClientHandlers,
  ): Promise<ResumedShimLaunch> {
    const connection = await connectShim(this.#provider, prepared.sandbox.id, { handlers });
    try {
      await connection.client.initialize();
      const summary = await connection.client.attachSession(sessionId);
      return { ...prepared, connection, sessionId, summary };
    } catch (error) {
      connection.close();
      await connection.closed.catch(() => {});
      throw error;
    }
  }

  prompt(opened: OpenShimLaunch): ShimLaunch {
    const turn = opened.connection.client.prompt(
      opened.sessionId,
      textBlocks(requestedPrompt(opened.claim)),
    );
    // The caller may deliberately observe this later, but retain a rejection
    // handler immediately so a transport failure cannot become unhandled.
    turn.catch(() => {});
    return { ...opened, turn };
  }

  async launch(claim: RunnerClaim, handlers: AcpClientHandlers = {}): Promise<ShimLaunch> {
    return this.prompt(await this.open(await this.prepare(claim), handlers));
  }

  /**
   * Resume any stopped/archived sandbox already serving a mission that has
   * queued Overlord work, so a later claim lands on a warm sandbox instead of
   * blocking the claim loop on a slow archived-sandbox restore. This creates
   * nothing: a mission with no sandbox yet is served fresh by the claim path,
   * and a running sandbox is left untouched. Matching prefers an explicit
   * mission label, then falls back to the shared project sandbox when the
   * claim's launch mode is project-scoped. Returns the ids of the sandboxes
   * that were started.
   */
  async wake(request: RunnerClaim): Promise<readonly string[]> {
    const missionBranch = await this.#missionBranchFor(request);
    // Project resolution is best-effort on the wake path: a queue item for a
    // working directory this gateway does not serve simply matches no sandbox.
    const target = await resolveProjectResource(request, this.#stateDirectory).catch(() => null);
    const launch =
      target === null
        ? undefined
        : resolveSandboxLaunch({
            claim: request,
            project: target.project,
            ...(missionBranch !== undefined ? { missionBranch } : {}),
            ...this.#strategyOptions(),
          });

    const selector =
      launch?.scope === 'project' && target !== null
        ? sandboxLabelSelector({
            project: target.project.name,
            mission: launch.sandboxMission,
          })
        : sandboxLabelSelector({ mission: request.missionId });
    const branch = launch?.branch ?? claimBranchName(request);
    const resumable = toSandboxes(await this.#provider.listSandboxes({ labels: selector })).filter(
      (sandbox) => isResumable(sandbox) && (branch === undefined || sandbox.branch === branch),
    );
    const started: string[] = [];
    for (const sandbox of resumable) {
      await ensureStarted(this.#provider, sandbox);
      started.push(sandbox.id);
    }
    return started;
  }

  /** Gateway-wide branching policy passed to every launch resolution. */
  #strategyOptions(): { strategy?: GatewayBranchStrategy; sharedBranch?: string } {
    return {
      ...(this.#branchStrategy !== undefined ? { strategy: this.#branchStrategy } : {}),
      ...(this.#sharedBranch !== undefined ? { sharedBranch: this.#sharedBranch } : {}),
    };
  }

  async #missionBranchFor(claim: RunnerClaim): Promise<MissionBranchInfo | undefined> {
    if (this.#loadMissionBranch !== undefined) return this.#loadMissionBranch(claim);
    if (this.#overlord === undefined) return undefined;
    return fetchMissionBranch({
      backendUrl: this.#overlord.backendUrl,
      token: this.#overlord.token,
      missionId: claim.missionId,
      ...(this.#overlord.deviceFingerprint !== undefined
        ? { deviceFingerprint: this.#overlord.deviceFingerprint }
        : {}),
    });
  }

  async #findOrCreateSandbox(options: {
    project: Project;
    launch: ResolvedSandboxLaunch;
  }): Promise<Sandbox> {
    const { project, launch } = options;
    const sandboxes = toSandboxes(
      await this.#provider.listSandboxes({
        labels: sandboxLabelSelector({
          project: project.name,
          mission: launch.sandboxMission,
        }),
      }),
    );
    const existing = sandboxes.find(
      (sandbox) => sandbox.branch === launch.branch && sandbox.state !== 'destroyed',
    );
    return (
      existing ??
      this.#createSandbox({
        project,
        sandboxMission: launch.sandboxMission,
        branch: launch.branch,
        baseBranch: launch.baseBranch,
        scope: launch.scope,
      })
    );
  }
}

/** Build the same provider adapter used by the Racecar CLI. */
export function gatewayProvider(env = process.env): SandboxProvider {
  const apiKey = env.DAYTONA_API_KEY;
  if (apiKey === undefined || apiKey.length === 0) throw new Error('DAYTONA_API_KEY is required');
  return new RetryingProvider(
    new DaytonaProvider({
      apiKey,
      ...(env.DAYTONA_API_URL !== undefined ? { apiUrl: env.DAYTONA_API_URL } : {}),
      ...(env.DAYTONA_ORGANIZATION_ID !== undefined
        ? { organizationId: env.DAYTONA_ORGANIZATION_ID }
        : {}),
      ...(env.DAYTONA_TARGET !== undefined ? { target: env.DAYTONA_TARGET } : {}),
    }),
  );
}

async function resolveProjectResource(
  claim: RunnerClaim,
  stateDirectory: string,
): Promise<{ project: Project; resourceKey: string; workspaceDir: string }> {
  const projectsDir = join(stateDirectory, '.racecar', 'projects');
  const files = await readdir(projectsDir);
  const projects = await Promise.all(
    files
      .filter((file) => file.endsWith('.json'))
      .map(async (file) => JSON.parse(await readFile(join(projectsDir, file), 'utf8')) as Project),
  );
  const matches = projects.flatMap((project) => {
    const resources =
      project.resources.length > 0
        ? project.resources
        : [{ key: 'primary', workspaceDir: project.workspaceDir }];
    return resources
      .filter((resource) => resource.workspaceDir === claim.workingDirectory)
      .map((resource) => ({
        project,
        resourceKey: resource.key,
        workspaceDir: resource.workspaceDir,
      }));
  });
  if (matches.length !== 1) {
    throw new Error(
      `cannot resolve runner working directory '${claim.workingDirectory ?? ''}' to exactly one Racecar project`,
    );
  }
  return matches[0]!;
}

function requestedPrompt(claim: RunnerClaim): string {
  const metadataPrompt =
    typeof claim.metadata?.prompt === 'string' ? claim.metadata.prompt : undefined;
  const prompt = claim.prompt ?? metadataPrompt;
  if (prompt === undefined || prompt.trim().length === 0) {
    throw new Error(`execution request '${claim.id}' has no prompt for the ACP session`);
  }
  return prompt;
}

/** A sandbox stopped/archived for cost that can be resumed in place. */
function isResumable(sandbox: Sandbox): boolean {
  return sandbox.state === 'stopped' || sandbox.state === 'archived';
}

async function ensureStarted(provider: SandboxProvider, sandbox: Sandbox): Promise<void> {
  if (isResumable(sandbox)) await provider.startSandbox(sandbox.id);
}

async function createSandboxViaCli(options: {
  provider: SandboxProvider;
  project: Project;
  sandboxMission: string;
  branch: string;
  baseBranch: string;
  scope: 'mission' | 'project';
  cwd: string;
}): Promise<Sandbox> {
  const { provider, project, sandboxMission, branch, baseBranch, scope, cwd } = options;
  const args = [
    'sandbox',
    'create',
    '--project',
    project.name,
    '--mission',
    sandboxMission,
    '--branch',
    branch,
    '--base-branch',
    baseBranch,
    '--json',
  ];
  if (scope === 'project') args.push('--shared');
  const { stdout } = await exec('racecar', args, { cwd, maxBuffer: 1024 * 1024 });
  const event = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { data?: { sandbox?: string } })
    .findLast((line) => line.data?.sandbox !== undefined);
  const id = event?.data?.sandbox;
  if (id === undefined) throw new Error('racecar sandbox create did not report a sandbox id');
  const sandboxes = toSandboxes(
    await provider.listSandboxes({
      labels: sandboxLabelSelector({ project: project.name, mission: sandboxMission }),
    }),
  );
  const sandbox = sandboxes.find((candidate) => candidate.id === id);
  if (sandbox === undefined) throw new Error(`created sandbox '${id}' could not be resolved`);
  return sandbox;
}
