/**
 * The claim path: make sure this family has declared which tree it writes in.
 *
 * A claim exists to precede a **write**, not to precede a thought. Nothing a
 * read-only session does can collide with anyone, so claiming during reading would
 * buy nothing and cost something — every session that merely starts would declare
 * itself, and the branch and worktree name would have to be chosen before the model
 * has looked at the repository and before the human has been asked. This runs from
 * the pre-write guard instead, which is also where `startFlow` and the naming tiers
 * already live, so a claim and the branch decision that follows it see the same
 * facts at the same moment.
 *
 * ## What it decides, and what it does not
 *
 * It decides the **tree**: the repository's main working tree, or one of the
 * family's own. A tree is free when no claim owns it — physical presence confers
 * nothing, because a session's working directory is immutable and a session
 * isolated into a worktree keeps the main tree as its `cwd` for the rest of its
 * life, so a rule that consulted `cwd` would mark that tree occupied forever.
 *
 * It does **not** decide the branch. A claim is written before any branch exists,
 * which is why the record's branch is nullable; `startFlow` fills it in, and only
 * for a branch this family actually opened. Recording whatever happens to be
 * checked out would make `/git-complete` offer to merge a stranger's branch.
 *
 * @module @dsh-external/dotdsh-git-flow/claim
 */

import type { Git } from "./exec.js";
import type { FlowConfig } from "./flow.js";
import { LockTimeoutError, withLock } from "./lock.js";
import {
  commonDir,
  defaultIntegrationBranch,
  isClaimLive,
  readLedger,
  repoRoot,
  updateClaim,
  worktreeList,
  type ClaimRegistry,
} from "./repo.js";

/**
 * The per-process skip: which families have already claimed, in which repository.
 *
 * A **cache with no authority**. It answers "has this family already claimed here,
 * in this process?" and never "is the recorded state still true". Its loss is a
 * miss — a restart, a cleared map, or a family that never claimed all take the same
 * path, which is to read the ledger and claim if needed — so nothing may be correct
 * only because the latch is warm. It exists to keep a once-per-family filesystem
 * write out of a per-tool-call gate, not to remember anything.
 */
export class ClaimLatch {
  readonly #claimed = new Set<string>();

  /**
   * The key one family's membership in one repository is stored under.
   *
   * @param repoKey - the repository's common git directory.
   * @param sessionId - the family identity.
   * @returns the cache key.
   */
  static key(repoKey: string, sessionId: string): string {
    return `${repoKey}\u0000${sessionId}`;
  }

  /**
   * Tell whether this family has already claimed in this repository.
   *
   * @param repoKey - the repository's common git directory.
   * @param sessionId - the family identity.
   * @returns whether the claim has already been made in this process.
   */
  has(repoKey: string, sessionId: string): boolean {
    return this.#claimed.has(ClaimLatch.key(repoKey, sessionId));
  }

  /**
   * Record that this family has claimed.
   *
   * @param repoKey - the repository's common git directory.
   * @param sessionId - the family identity.
   */
  mark(repoKey: string, sessionId: string): void {
    this.#claimed.add(ClaimLatch.key(repoKey, sessionId));
  }

  /**
   * Forget one family, in every repository.
   *
   * Called when a flow changes what the claim says — `/git-start` and
   * `/git-complete` — so the next write re-reads the ledger instead of trusting a
   * warm cache.
   *
   * @param sessionId - the family identity.
   */
  forget(sessionId: string): void {
    const suffix = `\u0000${sessionId}`;
    for (const key of this.#claimed) {
      if (key.endsWith(suffix)) this.#claimed.delete(key);
    }
  }
}

/** What the claim path needs from its caller. */
export interface ClaimDeps {
  /** A git client bound to the calling session's working directory. */
  readonly git: Git;
  /** The family identity: the root of the session's delegation chain. */
  readonly sessionId: string;
  /** This process's id. */
  readonly pid: number;
  /** The session registry, asked about the liveness of other claims. */
  readonly registry: ClaimRegistry;
  /** The resolved settings, for the integration branch default. */
  readonly config: FlowConfig;
  /** The per-process skip. */
  readonly latch: ClaimLatch;
  /** Where a broken lock is reported, when there is somewhere to report it. */
  readonly log?: { warn(message: string): void };
}

/** What claiming did. */
export type ClaimResult =
  | {
      /** The family has a claim; `changed` says whether this call wrote it. */
      readonly kind: "claimed";
      readonly changed: boolean;
    }
  | {
      /** The lock could not be taken, so no claim could be written. */
      readonly kind: "blocked";
      readonly reason: string;
    };

/**
 * Resolve the integration branch, tolerating a repository that has none.
 *
 * The claim records it for reporting only. A bare repository with no `main`,
 * `master` or `origin/HEAD` is unusual but not a reason to refuse to claim.
 *
 * @param git - any client for the repository.
 * @param config - the resolved settings.
 * @returns the branch name, or `null`.
 */
async function integrationOf(git: Git, config: FlowConfig): Promise<string | null> {
  if (config.integrationBranch !== undefined && config.integrationBranch !== "") return config.integrationBranch;
  return defaultIntegrationBranch(git).catch(() => null);
}

/**
 * Make sure this family has a claim, assigning it a tree if it has none.
 *
 * @param deps - the claim dependencies.
 * @returns what happened, or the reason nothing could.
 */
export async function ensureClaim(deps: ClaimDeps): Promise<ClaimResult> {
  const { git, sessionId, pid, latch, registry } = deps;

  // Everything git is asked is asked *here*, before the lock. Two sessions of one
  // dsh process share an event loop, so a git call inside the critical section
  // would leave the other session's write spinning behind it (see `lock.ts`).
  let own: string;
  let repoKey: string;
  let mainTree: string;
  let inWorktree: boolean;
  try {
    own = await repoRoot(git);
    repoKey = await commonDir(git);
    const trees = await worktreeList(git);
    mainTree = trees[0]?.path ?? own;
    inWorktree = own !== mainTree;
  } catch {
    return { kind: "blocked", reason: "the session's working directory is not inside a git repository" };
  }
  const integration = await integrationOf(git, deps.config);

  // The latched path does no I/O at all: no ledger read, no lock, no write. This is
  // the branch every file-mutating call after the first one takes.
  if (latch.has(repoKey, sessionId)) return { kind: "claimed", changed: false };

  try {
    const decided = await withLock(git, async () => {
      const claims = await readLedger(git);
      const existing = claims[sessionId];
      if (existing !== undefined) {
        // Already claimed: by this family earlier in this process, before this
        // process started, or by a process that shares the identity. The assignment
        // is kept — only the pid is refreshed, so another process does not read a
        // stale one and prune a claim that is very much alive. `false`, because the
        // caller only needs to re-read its position when a decision was just made.
        await updateClaim(git, sessionId, { pid, repoKey, repoRoot: mainTree });
        return false;
      }

      const others = Object.entries(claims)
        .filter(
          ([id, claim]) =>
            id !== sessionId && claim.repoKey === repoKey && isClaimLive(claim, registry, pid),
        )
        .map(([, claim]) => claim);
      const mainTaken = inWorktree || others.some((claim) => claim.tree === "main");

      await updateClaim(git, sessionId, {
        repoKey,
        repoRoot: mainTree,
        pid,
        tree: mainTaken ? "own" : "main",
        // A family already standing in a worktree of its own points at it; one that
        // has been assigned an own tree gets the path when it is created, from
        // `startFlow`, which is the only place that can name it.
        worktreePath: inWorktree ? own : null,
        integration,
      });
      return true;
    });

    latch.mark(repoKey, sessionId);
    return { kind: "claimed", changed: decided };
  } catch (error) {
    if (error instanceof LockTimeoutError) {
      const reason =
        "another session is holding this repository's claim lock and did not release it in time, so this " +
        "session could not record where it works. Try the write again; if it keeps failing, run " +
        "`/git-cleanup` and check for a stray `.dsh.local/git-flow.lock`.";
      deps.log?.warn(`git-flow: ${reason}`);
      return { kind: "blocked", reason };
    }
    throw error;
  }
}
