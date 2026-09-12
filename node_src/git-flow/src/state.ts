/**
 * Where one session stands: the repository facts around it, and the tree it may
 * write in.
 *
 * The guard asks this on every file-mutating call and the commands ask it once, so
 * what is cached here is deliberately the expensive, stable part — the working tree
 * and the integration branch of a directory, which cost several subprocesses to
 * resolve and do not change while a session runs. Everything that can change under
 * the session's feet is re-read on every call: the branch, and which tree the family
 * is assigned, because those are the facts the guard acts on.
 *
 * There used to be a per-session cache here as well, filled so that a *synchronous*
 * system-prompt provider could report the session's branch. That is gone with the
 * injection it existed for (see `prompt.ts`): the model is not told where it stands,
 * so the only readers left are the guard and the commands, and both can afford to ask.
 *
 * @module @dsh-external/dotdsh-git-flow/state
 */

import type { Git } from "./exec.js";
import { currentBranch, defaultIntegrationBranch, readLedger, repoRoot } from "./repo.js";
import type { FlowConfig } from "./flow.js";
import type { AgentLike } from "./session.js";

/** Where one session stands, as of the call that asked. */
export interface SessionPosition {
  /** Absolute path of the working tree this session's directory belongs to. */
  readonly repoRoot: string | undefined;
  /** The branch the session's tree has checked out, when not detached. */
  readonly branch: string | undefined;
  /** The branch features merge back into. */
  readonly integration: string | undefined;
  /** Absolute path of this session's worktree, when its claim names one. */
  readonly worktreePath: string | null;
  /** Whether the session's tree is on the integration branch. */
  readonly onIntegration: boolean;
}

/** Cached repository facts for one working directory. */
interface RepoFacts {
  /** The working tree this directory belongs to. */
  readonly repoRoot: string | undefined;
  /** The branch features merge back into, as this clone currently answers it. */
  readonly integration: string | undefined;
}

/**
 * Repository facts for the directories this session has asked about.
 *
 * Not a cache of *positions*: a session's branch and worktree are answered fresh
 * every time, because the guard's decisions turn on them and both can change between
 * two tool calls.
 */
export class GitFlowState {
  /** Repository facts keyed by the directory git was asked about. */
  readonly #repos = new Map<string, RepoFacts>();

  /**
   * Resolve, and cache, a directory's working tree and integration branch.
   *
   * @param git - a client bound to the directory.
   * @param config - the resolved settings.
   * @returns the cached facts; `undefined` fields mean "not a repository".
   */
  async repoOf(git: Git, config: FlowConfig): Promise<RepoFacts> {
    const cached = this.#repos.get(git.cwd);
    if (cached !== undefined) return cached;

    let facts: RepoFacts;
    try {
      const root = await repoRoot(git);
      const integration =
        config.integrationBranch !== undefined && config.integrationBranch !== ""
          ? config.integrationBranch
          : await defaultIntegrationBranch(git);
      facts = { repoRoot: root, integration };
    } catch {
      facts = { repoRoot: undefined, integration: undefined };
    }
    this.#repos.set(git.cwd, facts);
    return facts;
  }

  /**
   * Drop cached repository facts, so the next lookup re-reads them.
   *
   * The integration branch is read from refs — `origin/HEAD`, `main`, `master` — and a
   * clone can gain or change those under a running session, so callers that know
   * something changed invalidate rather than trust the answer forever.
   */
  invalidateRepos(): void {
    this.#repos.clear();
  }

  /**
   * Resolve where this session is standing now.
   *
   * @param git - a client bound to the session's working directory.
   * @param agent - the calling agent.
   * @param config - the resolved settings.
   * @param identity - the workflow's identity: the root of the session's delegation
   *   chain, which is also the key the ledger records under. A subagent asking with
   *   its own id would read no claim and be told it has no worktree — losing exactly
   *   the containment that keeps a family's edits inside the one it shares.
   * @returns the position as of this call.
   */
  async position(
    git: Git,
    agent: AgentLike,
    config: FlowConfig,
    identity: string,
  ): Promise<SessionPosition> {
    const facts = await this.repoOf(git, config);

    const branch = facts.repoRoot === undefined ? undefined : await currentBranch(git);
    const claim = facts.repoRoot === undefined ? undefined : (await readLedger(git))[identity];

    return {
      repoRoot: facts.repoRoot,
      branch,
      integration: facts.integration,
      worktreePath: claim?.worktreePath ?? null,
      onIntegration: branch !== undefined && facts.integration !== undefined && branch === facts.integration,
    };
  }
}
