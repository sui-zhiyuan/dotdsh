/**
 * git-flow's core: the four low-level operations every other part of the plugin
 * is built on.
 *
 * Everything above this module is presentation. A slash command renders what one
 * of these returns; the pre-write guard asks {@link ensureWorkspace} where the
 * calling session is allowed to write. Neither decides anything itself — the
 * branch, the worktree and the claim file are all settled here, which is what
 * lets the decisions be driven against a scratch repository with no harness
 * present.
 *
 * ## The claim
 *
 * A claim is the durable answer to "which working tree does this session write
 * in". It is keyed by the **root of the delegation chain**, not by the immediate
 * session: a subagent shares its parent's working directory, so a branch opened
 * for one of them is opened for all of them, and keying by the immediate session
 * would let a second member of the same family be mistaken for a stranger and
 * open a second branch in the same tree.
 *
 * ## Why a worktree
 *
 * One repository, one checkout: two sessions writing in the main tree collide,
 * and the first one to open a branch silently moves the tree out from under the
 * second. A family that is not alone gets a worktree of its own, so its edits
 * cannot reach another family's tree at all.
 *
 * ## What this module does not own
 *
 * Running git is `exec`'s job, and the claim file's format and its exclusive
 * access belong to the claim module — including the lock, which is taken on the
 * file descriptor itself, so that one `open → read → modify → write → close` is
 * the whole critical section. This module states what it needs from both and
 * nothing more, and the process seam arrives as an argument: it is never imported
 * here, and a test can drive every path against a scratch repository with no
 * harness. Pinning a session's working directory to the worktree it was given is
 * an upstream wrapper's job, not this one's.
 *
 * ## Layer
 *
 * The core: the workflow's own decisions. It may use `platform` and never the
 * boundary, and no dsh type reaches it — no invocation, no tool execution, no
 * context — which is exactly what lets the whole path be driven from a scratch
 * repository.
 *
 * @module @dsh-external/dotdsh-git-flow/core
 */

import type { Runner } from "../platform/exec.js";

/**
 * Where every family's worktree is created, relative to the repository's main
 * tree. Hardcoded for now: every path this module reports is derived from it.
 */
const WORKTREE_ROOT = ".dsh.local/worktrees";

/** Where one family works: the branch it commits on, and the tree it writes in. */
export interface FamilyWorkspace {
  /** The family's feature branch. */
  readonly branch: string;
  /** Absolute path of the family's worktree. Never the repository's main tree. */
  readonly workTree: string;
}

/**
 * Per-family memo of the resolved workspace, keyed by the root session id.
 *
 * Written **last** in {@link ensureWorkspace}, once the branch and the worktree
 * both exist — so a failure anywhere earlier caches nothing, the next call reads
 * the claim file again, and the whole path stays re-entrant and retryable. That
 * is what lets a status check run it on the hot path.
 *
 * An entry that is present and `null` means "asked, and this family holds no
 * claim"; an absent entry means "not resolved yet". An entry is dropped together
 * with the claim record it mirrors — by {@link gitComplete}'s last step, and by
 * {@link gitClean} — the two operations that take a workspace away. Dropping it
 * earlier would let a retry rebuild a worktree it is about to delete again.
 *
 * Process-local by design: a cache of a fact the claim file already owns, never
 * the fact itself. Another process can change the file underneath it.
 */
const sessionWorkspaceMemo = new Map<string, FamilyWorkspace | null>();

/**
 * Start a family: claim a working tree for it, then report where it works.
 *
 * The claim is written **before** the branch or the worktree exists, so a second
 * session arriving during setup sees the tree as taken instead of racing for it.
 *
 * Contract:
 *
 * - parameter checks (path is inside the repository, branch name is legal, the
 *   path and the branch are both free) are the caller's, and are not repeated
 *   here;
 * - **throws** when this family already holds a claim. Starting is not how a
 *   session moves between trees: `/git-complete` releases the old claim first;
 * - appends this family's record to the claim file;
 * - then does exactly what {@link ensureWorkspace} does, and returns its result —
 *   so a caller never needs to call both.
 *
 * @param runner - the process seam every git call goes through.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param sessionId - root of the calling session's delegation chain.
 * @param branch - feature branch to create for the family.
 * @param worktreeName - directory name of the family's worktree, under
 *   {@link WORKTREE_ROOT}.
 * @returns the branch and the absolute path of the tree the family works in.
 */
export async function gitStart(
  runner: Runner,
  repoRoot: string,
  sessionId: string,
  branch: string,
  worktreeName: string,
): Promise<FamilyWorkspace> {
  throw new Error("gitStart is not implemented");
}

/**
 * Resolve where a family works, creating whatever is missing.
 *
 * Named for what it does rather than for what it looks like: it is the question
 * "where may this session write", but answering it **creates** the branch and the
 * worktree when they are not there yet, so it is not a read.
 *
 * Contract:
 *
 * - the memo is consulted first — a family whose workspace is already resolved
 *   returns immediately and runs no git command;
 * - otherwise the claim file is read for this session id. No record means the
 *   family has no claim, which is a normal state and not an error;
 * - a recorded branch that does not exist yet is created;
 * - a recorded worktree that does not exist yet is created at
 *   `WORKTREE_ROOT/<worktreeName>` — never the main tree, which is exactly what a
 *   family is isolated from;
 * - every step is idempotent, and the memo is written only after the last one
 *   succeeds, so a failure leaves the state retryable rather than poisoned.
 *
 * @param runner - the process seam every git call goes through.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param sessionId - root of the calling session's delegation chain.
 * @returns the branch and the absolute path of the tree the family works in, or
 *   `null` when this family holds no claim.
 */
export async function ensureWorkspace(
  runner: Runner,
  repoRoot: string,
  sessionId: string,
): Promise<FamilyWorkspace | null> {
  throw new Error("ensureWorkspace is not implemented");
}

/** The step of {@link gitComplete} that failed. */
export type CompleteStep = "merge" | "remove-worktree" | "delete-branch" | "remove-claim";

/**
 * The outcome of {@link gitComplete}.
 *
 * The shape exists because the caller owes the human a different sentence for
 * each one, and because a failure is not something to reword: it hands back the
 * step, the command, and git's own output.
 */
export type CompleteResult =
  /** The family is finished; `merged` says whether a merge was needed. */
  | { readonly kind: "done"; readonly merged: boolean }
  /** No claim was recorded: a previous call already finished this family. */
  | { readonly kind: "nothing-to-do" }
  /**
   * The branch is not a descendant of `master`, so nothing was written. The
   * caller turns this into the instruction to replay the branch —
   * `git rebase --onto master <merge-base> <branch>` — and calls again.
   */
  | { readonly kind: "not-descendant"; readonly branch: string }
  /** A step failed and stopped the sequence; `command` and `error` are verbatim. */
  | { readonly kind: "failed"; readonly step: CompleteStep; readonly command: string; readonly error: string };

/**
 * Finish a family: merge its branch back, then take away everything it held.
 *
 * Re-entrant by construction. "Unfinished" is defined by the claim record, so a
 * second call — or a call for a family that never started — reports
 * `nothing-to-do` instead of failing; and every step is skipped when it is
 * already done, so a retry after a failure resumes rather than restarts.
 *
 * The step order is what makes that true:
 *
 * 1. **merge** — only when the branch still has commits `master` does not. The
 *    branch must also be a **descendant of `master`**: merging a branch whose
 *    branch point is behind `master` would bury the replay inside the merge
 *    commit, so nothing is written and `not-descendant` is reported instead, for
 *    the caller to turn into "replay this branch and call again". After a
 *    successful merge the commits are in `master`, so the step skips itself on a
 *    retry;
 * 2. **remove-worktree**;
 * 3. **delete-branch**;
 * 4. **remove-claim** — the commit point. The family is not finished until its
 *    record is gone, so a failure here is a failure even though the merge has
 *    already happened and the tree and the branch are already gone.
 *
 * The first step that fails stops the sequence and is reported as
 * `failed{step, command, error}`. Cleanup steps count as failures too: with an
 * idempotent merge there is nothing dangerous about retrying them, and reporting
 * them is what keeps a claim from outliving its branch.
 *
 * Contract:
 *
 * - resolves the family through {@link ensureWorkspace};
 * - no claim, or a claim whose work is already all in `master` and already
 *   released, is `nothing-to-do`;
 * - the integration branch is `master` for now;
 * - a branch that is not a descendant of `master` is never merged:
 *   `not-descendant` carries it, and the caller asks for the replay — nothing is
 *   written, so calling again after the rebase is the whole retry;
 * - the merge is `--no-ff` under `mergeMessage`.
 *
 * @param runner - the process seam every git call goes through.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param sessionId - root of the calling session's delegation chain.
 * @param mergeMessage - subject of the merge commit, supplied by the model.
 * @returns what happened, in the terms the caller has to explain.
 */
export async function gitComplete(
  runner: Runner,
  repoRoot: string,
  sessionId: string,
  mergeMessage: string,
): Promise<CompleteResult> {
  // TODO: `master` is hardcoded. Read the integration branch from configuration
  // once the rewrite needs more than this repository — the previous
  // implementation detected `origin/HEAD`, then `main`, then `master`.
  throw new Error("gitComplete is not implemented");
}

/**
 * Reclaim what unrecoverable sessions left behind.
 *
 * A session that was killed, or whose turn ended without `/git-complete`, leaves
 * a claim behind, usually with a worktree and a branch. Until that session is
 * archived it can still come back and expect its worktree to be there, so the
 * sweep is gated on recoverability, not on liveness: the caller passes what can
 * still be resumed, and everything else is fair game.
 *
 * Contract:
 *
 * - every claim whose session id is **not** in `resumableSessionIds` is visited;
 * - its claim record is dropped from the claim file, its memo entry is dropped,
 *   its feature branch is deleted and its worktree removed;
 * - a claim held by a session that can still be resumed is left exactly as it is.
 *
 * @param runner - the process seam every git call goes through.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param resumableSessionIds - session ids that can still be resumed, and whose
 *   claims are therefore off limits. A claim outside this set belongs to a
 *   session that is archived and can no longer come back for it.
 */
export async function gitClean(
  runner: Runner,
  repoRoot: string,
  resumableSessionIds: readonly string[],
): Promise<void> {
  throw new Error("gitClean is not implemented");
}
