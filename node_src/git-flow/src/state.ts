/**
 * The plugin's short-lived memory of where each session is.
 *
 * Two consumers cannot afford to ask git themselves:
 *
 * - the system-prompt contribution is a **synchronous** text provider, so it can
 *   only read a value someone else already computed;
 * - the pre-write guard runs on **every** file-mutating tool call, so an
 *   unbounded number of git subprocesses per turn is not acceptable.
 *
 * So this cache is refreshed by the two paths that run anyway — the pre-write
 * guard and the commands — and read by the prompt. The split is deliberate about
 * what may be stale:
 *
 * - **the branch** is re-read on every refresh, because it is the fact the guard
 *   acts on and it is one cheap `symbolic-ref`;
 * - **the repository root and integration branch** are cached per working
 *   directory, because resolving them costs several subprocesses and neither
 *   changes while a session runs.
 *
 * A prompt that is one step stale about the branch is harmless: the guard, not
 * the prompt, is what enforces the invariant.
 *
 * @module @dsh-external/dotdsh-git-flow/state
 */

import type { Git } from "./exec.js";
import { currentBranch, defaultIntegrationBranch, readLedger, repoRoot, worktreeList } from "./repo.js";
import type { FlowConfig } from "./flow.js";
import { sessionId, sessionCwd, type AgentLike } from "./session.js";

/** What the prompt and the guard know about one session. */
export interface SessionSnapshot {
  /** Absolute path of the session's working directory. */
  readonly cwd: string;
  /** Absolute path of the working tree this session's directory belongs to. */
  readonly repoRoot: string | undefined;
  /** Absolute path of the repository's main working tree, shared by every worktree. */
  readonly mainTree: string | undefined;
  /** The branch the session's tree has checked out, when not detached. */
  readonly branch: string | undefined;
  /** The branch features merge back into. */
  readonly integration: string | undefined;
  /** This session's worktree, when it has one. */
  readonly worktreePath: string | null;
  /** Whether the session's tree is on the integration branch. */
  readonly onIntegration: boolean;
}

/** Cached repository facts for one working directory. */
interface RepoFacts {
  /** The working tree this directory belongs to. */
  readonly repoRoot: string | undefined;
  /**
   * The repository's main working tree, which is what tells "someone else is in
   * *my* checkout" from "someone else is in theirs" — a distinction the guard
   * needs and a session id alone cannot make.
   */
  readonly mainTree: string | undefined;
  readonly integration: string | undefined;
}

/**
 * Per-session and per-repository facts, refreshed by the paths that already run
 * git and read by the synchronous prompt provider.
 */
export class GitFlowState {
  /** Repository facts keyed by the directory git was asked about. */
  readonly #repos = new Map<string, RepoFacts>();
  /** The latest snapshot per session id. */
  readonly #sessions = new Map<string, SessionSnapshot>();

  /**
   * Resolve, and cache, the repository root and integration branch for a
   * directory.
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
      const trees = await worktreeList(git);
      facts = { repoRoot: root, mainTree: trees[0]?.path ?? root, integration };
    } catch {
      facts = { repoRoot: undefined, mainTree: undefined, integration: undefined };
    }
    this.#repos.set(git.cwd, facts);
    return facts;
  }

  /**
   * Drop cached repository facts, so the next lookup re-reads them.
   *
   * Called after this plugin changes a branch itself, and available to callers
   * that know a manual change happened.
   */
  invalidateRepos(): void {
    this.#repos.clear();
  }

  /**
   * Re-read this session's position and remember it.
   *
   * @param git - a client bound to the session's working directory.
   * @param agent - the calling agent.
   * @param config - the resolved settings.
   * @returns the fresh snapshot.
   */
  async refresh(git: Git, agent: AgentLike, config: FlowConfig): Promise<SessionSnapshot> {
    const id = sessionId(agent);
    const cwd = sessionCwd(agent) ?? git.cwd;
    const facts = await this.repoOf(git, config);

    const branch = facts.repoRoot === undefined ? undefined : await currentBranch(git);
    const worktreePath = facts.repoRoot === undefined ? null : ((await readLedger(git))[id]?.worktreePath ?? null);

    const snapshot: SessionSnapshot = {
      cwd,
      repoRoot: facts.repoRoot,
      mainTree: facts.mainTree,
      branch,
      integration: facts.integration,
      worktreePath,
      onIntegration: branch !== undefined && facts.integration !== undefined && branch === facts.integration,
    };
    this.#sessions.set(id, snapshot);
    return snapshot;
  }

  /**
   * The last snapshot taken for a session.
   *
   * @param id - the session id.
   * @returns the snapshot, or `undefined` before the session's first refresh.
   */
  snapshot(id: string): SessionSnapshot | undefined {
    return this.#sessions.get(id);
  }
}
