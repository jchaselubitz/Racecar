import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connectShim, type ShimConnection } from '@racecar/cli/shim-connect';
import {
  DaytonaProvider,
  RetryingProvider,
  sandboxLabelSelector,
  toSandboxes,
} from '@racecar/core';
import { textBlocks } from '@racecar/shim';
import type { AcpClientHandlers, PromptResponse, SessionSummary } from '@racecar/shim';
import type { Project, Sandbox, SandboxProvider } from '@racecar/core';

const exec = promisify(execFile);

/** The subset of a plain runner claim needed to select a Racecar workspace. */
export interface RunnerClaim {
  readonly id: string;
  readonly missionId: string;
  readonly projectId?: string;
  readonly workingDirectory?: string;
  readonly requestedAgent?: string;
  readonly branch?: string;
  readonly prompt?: string;
  readonly metadata?: Record<string, unknown>;
}

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
  /** Injectable for tests and for deployments where the CLI has another path. */
  readonly createSandbox?: (
    project: Project,
    missionId: string,
    branch: string,
  ) => Promise<Sandbox>;
}

/**
 * Starts an Overlord-originated request in a Racecar sandbox without ever
 * spawning an agent process in the gateway. The ACP shim remains the sole
 * owner of the agent session.
 *
 * The durable gateway-state store owns request-to-session idempotency. This
 * adapter exposes both fresh and resumed ACP connections while always
 * preferring an existing matching car.
 */
export class ShimLaunchAdapter {
  readonly #provider: SandboxProvider;
  readonly #stateDirectory: string;
  readonly #createSandbox: (
    project: Project,
    missionId: string,
    branch: string,
  ) => Promise<Sandbox>;

  constructor(options: LaunchAdapterOptions) {
    this.#provider = options.provider;
    this.#stateDirectory = options.stateDirectory ?? process.cwd();
    this.#createSandbox =
      options.createSandbox ??
      ((project, missionId, branch) =>
        createSandboxViaCli(this.#provider, project, missionId, branch, this.#stateDirectory));
  }

  async prepare(claim: RunnerClaim): Promise<PreparedShimLaunch> {
    const target = await resolveProjectResource(claim, this.#stateDirectory);
    const { project } = target;
    const branch = requestedBranch(claim, project);
    const sandbox = await this.#findOrCreateSandbox(project, claim.missionId, branch);
    await ensureStarted(this.#provider, sandbox);
    return {
      claim,
      project,
      resourceKey: target.resourceKey,
      branch,
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
   * and a running sandbox is left untouched. Matching by mission label keeps
   * the wake independent of project resolution, so a queue item this gateway
   * does not serve simply matches no sandbox and is skipped. Returns the ids of
   * the sandboxes that were started.
   */
  async wake(request: RunnerClaim): Promise<readonly string[]> {
    const branch = claimBranch(request);
    const resumable = toSandboxes(
      await this.#provider.listSandboxes({
        labels: sandboxLabelSelector({ mission: request.missionId }),
      }),
    ).filter((sandbox) => isResumable(sandbox) && (branch === undefined || sandbox.branch === branch));
    const started: string[] = [];
    for (const sandbox of resumable) {
      await ensureStarted(this.#provider, sandbox);
      started.push(sandbox.id);
    }
    return started;
  }

  async #findOrCreateSandbox(
    project: Project,
    missionId: string,
    branch: string,
  ): Promise<Sandbox> {
    const sandboxes = toSandboxes(
      await this.#provider.listSandboxes({
        labels: sandboxLabelSelector({ project: project.name, mission: missionId }),
      }),
    );
    const existing = sandboxes.find(
      (sandbox) => sandbox.branch === branch && sandbox.state !== 'destroyed',
    );
    return existing ?? this.#createSandbox(project, missionId, branch);
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

/** The branch the claim itself names, before any project-default fallback. */
export function claimBranch(claim: RunnerClaim): string | undefined {
  if (claim.branch !== undefined) return claim.branch;
  return typeof claim.metadata?.branch === 'string' ? claim.metadata.branch : undefined;
}

function requestedBranch(claim: RunnerClaim, project: Project): string {
  return claimBranch(claim) ?? project.defaultBranch;
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

async function createSandboxViaCli(
  provider: SandboxProvider,
  project: Project,
  missionId: string,
  branch: string,
  cwd: string,
): Promise<Sandbox> {
  const { stdout } = await exec(
    'racecar',
    [
      'sandbox',
      'create',
      '--project',
      project.name,
      '--mission',
      missionId,
      '--branch',
      branch,
      '--json',
    ],
    { cwd, maxBuffer: 1024 * 1024 },
  );
  const event = stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { data?: { sandbox?: string } })
    .findLast((line) => line.data?.sandbox !== undefined);
  const id = event?.data?.sandbox;
  if (id === undefined) throw new Error('racecar sandbox create did not report a sandbox id');
  const sandboxes = toSandboxes(
    await provider.listSandboxes({
      labels: sandboxLabelSelector({ project: project.name, mission: missionId }),
    }),
  );
  const sandbox = sandboxes.find((candidate) => candidate.id === id);
  if (sandbox === undefined) throw new Error(`created sandbox '${id}' could not be resolved`);
  return sandbox;
}
