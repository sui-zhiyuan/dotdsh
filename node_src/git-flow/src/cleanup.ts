/**
 * `/git-cleanup`: what a session that was closed without finishing leaves behind.
 *
 * A session can end at any moment — the thread is closed, the process is killed —
 * and what it leaves is a claim in the ledger, a worktree, and a branch. The claim
 * is the only one of the three that cannot be re-derived from git afterwards: "this
 * branch was opened by a session" is information nothing else records. So this
 * command reports before it removes, and it never deletes work:
 *
 * - a **clean** worktree that no live family owns is removed, because it is a
 *   checkout of a commit that still exists and nothing is in it;
 * - a **dirty** worktree is reported and left alone — uncommitted work exists
 *   nowhere else, and this is the last place it is visible;
 * - a **branch** with commits the integration branch does not have is reported and
 *   left alone. Deleting unmerged work is how work goes missing in a repository,
 *   and no amount of bookkeeping makes that recoverable.
 *
 * Claims whose owner is gone are dropped, and this is the moment their branches are
 * named: after the drop, the ledger no longer knows the branch was ever opened. That
 * is the same policy `otherLiveClaims` already applies when it prunes — one policy
 * for the whole plugin, and never a silent one.
 *
 * @module @dsh-external/dotdsh-git-flow/cleanup
 */

import { isAbsolute, join, relative } from "node:path";
import type { Git } from "./exec.js";
import { integrationOf, type FlowConfig } from "./flow.js";
import { withLock } from "./lock.js";
import {
  commonDir,
  isAncestor,
  isClean,
  isClaimLive,
  localStatePathspec,
  readLedger,
  repoRoot,
  revParse,
  worktreeList,
  writeLedger,
  type ClaimRegistry,
  type SessionClaim,
} from "./repo.js";

/** A worktree this command refused to remove, and why. */
export interface KeptWorktree {
  /** Absolute path of the worktree. */
  readonly path: string;
  /** Why it was left in place. */
  readonly reason: string;
}

/** What `/git-cleanup` did and what it left for a human. */
export interface CleanupResult {
  /** Worktrees removed, because nothing was in them. */
  readonly removedWorktrees: readonly string[];
  /** Worktrees left in place, with the reason. */
  readonly keptWorktrees: readonly KeptWorktree[];
  /** Branches with commits the integration branch does not have. */
  readonly unmergedBranches: readonly string[];
  /** Claims dropped because their owner is gone. */
  readonly forgottenClaims: readonly string[];
  /** Claims still in force, which this command never touches. */
  readonly liveClaims: number;
}

/** What cleaning up needs. */
export interface CleanupDeps {
  /** A git client bound to the calling session's working directory. */
  readonly git: Git;
  /** The resolved settings. */
  readonly config: FlowConfig;
  /** The session registry, for the liveness of each claim. */
  readonly registry: ClaimRegistry;
  /** The calling process's id. */
  readonly pid: number;
  /** Cancellation owned by the caller. */
  readonly signal?: AbortSignal;
}

/**
 * Tell whether a path is the same as, or below, another.
 *
 * @param parent - the presumed containing directory.
 * @param child - the path to test.
 * @returns whether `child` is inside `parent`.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Remove every worktree nothing is working in, and report everything else.
 *
 * @param deps - the cleanup dependencies.
 * @returns what was removed and what was left.
 * @throws GitError when the session's directory is not inside a repository.
 */
export async function cleanupFlow(deps: CleanupDeps): Promise<CleanupResult> {
  const { git, config, registry, pid, signal } = deps;
  const abort = signal === undefined ? {} : { signal };

  const own = await repoRoot(git);
  const repoKey = await commonDir(git);
  const trees = await worktreeList(git);
  const mainTree = trees[0]?.path ?? own;
  const integration = await integrationOf(git, config);
  const localState = localStatePathspec(mainTree, config.worktreeRoot);

  // Pruning happens under the ledger's lock, like every other write to it: another
  // process may be claiming at this moment, and a read-modify-write outside the lock
  // would drop its claim. Only the ledger is touched in here — the liveness test is
  // the registry's, which is synchronous.
  const { live, forgottenClaims } = await withLock(git, async () => {
    const claims = await readLedger(git);
    const stillLive = new Map<string, SessionClaim>();
    const dropped: string[] = [];
    const keptClaims: Record<string, SessionClaim> = {};

    for (const [id, claim] of Object.entries(claims)) {
      if (claim.repoKey !== repoKey) {
        // Another repository's claim: not this command's to judge.
        keptClaims[id] = claim;
        continue;
      }
      if (isClaimLive(claim, registry, pid)) {
        stillLive.set(id, claim);
        keptClaims[id] = claim;
        continue;
      }
      // The owner is gone. Its branch is named here because after this write the
      // ledger no longer knows the branch was ever opened.
      dropped.push(claim.branch ?? id);
    }

    if (dropped.length > 0) await writeLedger(git, keptClaims);
    return { live: stillLive, forgottenClaims: dropped };
  });

  // The branches a dropped claim named, plus any feature branch that is not merged.
  // Both are reported and neither is deleted: a branch with commits the integration
  // branch does not have is work, and this command has no way to know whose it was.
  const integrationTip = await revParse(git, integration).catch(() => undefined);
  const featureBranches = (await git.text(["branch", "--list", "--format=%(refname:short)"]))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && line.startsWith(config.branchPrefix));
  const unmergedBranches: string[] = [];
  for (const branch of featureBranches) {
    const owned = [...live.values()].some((claim) => claim.branch === branch);
    if (owned) continue;
    if (integrationTip !== undefined && (await isAncestor(git, branch, integration))) continue;
    unmergedBranches.push(branch);
  }

  // A worktree is a candidate when it is not the main tree and no live claim owns it.
  const worktreeRoot = join(mainTree, config.worktreeRoot);
  const removedWorktrees: string[] = [];
  const keptWorktrees: KeptWorktree[] = [];

  for (const tree of trees) {
    if (tree.path === mainTree) continue;
    if (!isInside(worktreeRoot, tree.path)) continue;
    if ([...live.values()].some((claim) => claim.worktreePath === tree.path)) continue;

    const treeGit = git.withCwd(tree.path);
    if (!(await isClean(treeGit, localState))) {
      keptWorktrees.push({
        path: tree.path,
        reason: "it has uncommitted changes, which exist nowhere else",
      });
      continue;
    }

    // Removed even when the branch checked out here is unmerged: `git worktree remove`
    // takes the checkout, not the branch, and the branch is reported below either way.
    // What must never be deleted is the *work*, and that lives in the branch.
    const removal = await git.run(["worktree", "remove", tree.path], abort);
    if (removal.code === 0) removedWorktrees.push(tree.path);
    else keptWorktrees.push({ path: tree.path, reason: removal.stderr.trim() || "git refused to remove it" });
  }

  return {
    removedWorktrees,
    keptWorktrees,
    unmergedBranches,
    forgottenClaims,
    liveClaims: live.size,
  };
}
