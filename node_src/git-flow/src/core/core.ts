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

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimStore } from "../platform/claim.js";
import type { Claim } from "../platform/claim.js";
import { GitClient } from "../platform/exec.js";
import type { Runner } from "../platform/exec.js";

/**
 * Where every family's worktree is created, relative to the repository's main
 * tree. Hardcoded for now: every path this module reports is derived from it.
 */
const WORKTREE_ROOT = ".dsh.local/worktrees";

/**
 * How old a claim must be before a sweep may take it.
 *
 * Unrecoverable is not enough on its own. A session that was archived a minute
 * ago is one a human may be about to reopen, and a sweep that ran in that window
 * would take the worktree out from under a family that was coming back. A day is
 * long enough that nobody is still coming back for it, and short enough that a
 * dead worktree does not sit there for a week.
 */
const CLAIM_SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/** Where one family works: the branch it commits on, and the tree it writes in. */
export interface FamilyWorkspace {
  /** The family's feature branch. */
  readonly branch: string;
  /** Absolute path of the family's worktree. Never the repository's main tree. */
  readonly workTree: string;
}

/**
 * One family's memoized workspace, and whether its tree is known to exist.
 */
interface MemoEntry {
  /** The branch and the worktree the family's claim names. */
  readonly workspace: FamilyWorkspace;
  /**
   * Whether both were created, or found already there.
   *
   * `true` is the state that lets a write skip every git call: nothing about a
   * family's tree changes except through this module, and every operation that
   * changes it drops the entry. `false` means the paths are known — so the claim
   * file and its lock are not touched again — while the existence checks still
   * run, which is what makes an attempt that died halfway retryable.
   */
  readonly complete: boolean;
}

/**
 * Per-family memo of the resolved workspace, keyed by the root session id.
 *
 * Four states, each of which means something different:
 *
 * - **absent** — not resolved yet;
 * - **`null`** — asked, and this family holds no claim;
 * - **`complete: false`** — the claim named a branch and a worktree, and nothing
 *   is known yet about whether they exist;
 * - **`complete: true`** — both are there, so the resolution short-circuits with
 *   no git call and no claim file read at all. This is the state a write on the
 *   hot path needs.
 *
 * `complete` is only ever set where the work succeeded: {@link ensureWorkspace}
 * marks it once the branch and the worktree are both in place, so a failure
 * leaves an incomplete entry rather than a lie, and the next call resumes instead
 * of starting over. An entry is dropped together with the claim record it mirrors
 * — by {@link gitComplete}'s last step, and by {@link gitClean} — the two
 * operations that take a workspace away. Dropping it earlier would let a retry
 * rebuild a worktree it is about to delete again.
 *
 * Process-local by design: a cache of a fact the claim file already owns, never
 * the fact itself. Another process can change the file underneath it.
 */
const sessionWorkspaceMemo = new Map<string, MemoEntry | null>();

/**
 * The integration branch, until the rewrite needs more than this repository.
 *
 * One name rather than a literal at each use site: the day the TODO below comes
 * true, this is the one place that changes.
 */
const INTEGRATION_BRANCH = "master";

/** Where a family's worktree lives, given the name its claim records. */
function worktreePathOf(repoRoot: string, worktreeName: string): string {
  return join(repoRoot, WORKTREE_ROOT, worktreeName);
}

/**
 * Whether a local branch exists.
 *
 * @param git - a client bound anywhere in the repository.
 * @param branch - short branch name.
 * @param signal - cancellation owned by the caller, forwarded to git.
 * @returns whether `refs/heads/<branch>` resolves.
 */
function branchExists(git: GitClient, branch: string, signal?: AbortSignal): Promise<boolean> {
  return git.ok(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { signal });
}

/**
 * One working tree, as `git worktree list --porcelain` reports it.
 */
interface WorktreeListing {
  /** Absolute path of the working tree. */
  readonly path: string;
  /** Short name of the branch checked out there, when there is one. */
  readonly branch: string | undefined;
}

/**
 * Undo git's C-style quoting of a porcelain path.
 *
 * Porcelain output quotes a path that holds `"` or a control character, and the
 * comparison these listings feed would silently miss it while the worktree is
 * right there. The escapes git emits are the handful handled here.
 *
 * @param value - the path as git printed it.
 * @returns the path as a filesystem path.
 */
function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value
    .slice(1, -1)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t");
}

/**
 * The repository's working trees, as git lists them.
 *
 * Records are separated by a blank line, and a `branch` line belongs to the
 * `worktree` line above it — reading them independently would hand a tree the
 * branch of its neighbour.
 *
 * @param git - a client bound anywhere in the repository.
 * @param signal - cancellation owned by the caller, forwarded to git.
 * @returns one entry per working tree, in git's own order.
 */
async function worktreeListings(
  git: GitClient,
  signal?: AbortSignal,
): Promise<readonly WorktreeListing[]> {
  const porcelain = await git.text(["worktree", "list", "--porcelain"], { signal });
  const listings: WorktreeListing[] = [];
  let path: string | undefined;
  let branch: string | undefined;

  const flush = (): void => {
    if (path !== undefined) listings.push({ path, branch });
    path = undefined;
    branch = undefined;
  };

  for (const line of porcelain.split("\n")) {
    if (line === "") flush();
    else if (line.startsWith("worktree ")) path = unquotePath(line.slice("worktree ".length));
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
  }
  flush();
  return listings;
}

/**
 * Whether a working tree is registered at a path.
 *
 * Asking git rather than the filesystem is what makes `worktree add` idempotent:
 * git is the one that decides whether a path is taken, and a directory left at a
 * pruned worktree's path would otherwise read as "already there".
 *
 * @param git - a client bound anywhere in the repository.
 * @param path - absolute path of the working tree.
 * @param signal - cancellation owned by the caller, forwarded to git.
 * @returns whether git lists a worktree there.
 */
async function worktreeExists(git: GitClient, path: string, signal?: AbortSignal): Promise<boolean> {
  return (await worktreeListings(git, signal)).some((listing) => listing.path === path);
}

/**
 * The working tree that has a branch checked out, when there is one.
 *
 * Git allows a branch to be checked out in at most one working tree, so at most
 * one entry matches — which is what answers "where may the merge into the
 * integration branch run without hijacking a checkout this plugin does not own".
 *
 * @param git - a client bound anywhere in the repository.
 * @param branch - short branch name.
 * @param signal - cancellation owned by the caller, forwarded to git.
 * @returns the absolute path of the matching tree, or `undefined`.
 */
async function treeWithBranch(
  git: GitClient,
  branch: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  return (await worktreeListings(git, signal)).find((listing) => listing.branch === branch)?.path;
}

/** Drop a family's memo entry, so the next resolution reads the claim file again. */
function forgetWorkspace(sessionId: string): void {
  sessionWorkspaceMemo.delete(sessionId);
}

/**
 * The branch and the worktree a family's claim names, creating whatever is
 * missing.
 *
 * Every step is skipped when it is already done, because this is also the
 * resolution a retry runs after a failure: the claim file is the authority and
 * the memo only remembers what the last attempt saw.
 *
 * @param runner - the process seam every git call goes through.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param sessionId - root of the calling session's delegation chain.
 * @param workspace - the paths the family's claim names.
 * @param signal - cancellation owned by the caller, forwarded to git.
 * @returns the workspace, once both the branch and the worktree exist.
 */
async function materializeWorkspace(
  runner: Runner,
  repoRoot: string,
  sessionId: string,
  workspace: FamilyWorkspace,
  signal?: AbortSignal,
): Promise<FamilyWorkspace> {
  const git = new GitClient(runner, repoRoot);
  if (!(await branchExists(git, workspace.branch, signal))) {
    await git.text(["branch", workspace.branch], { signal });
  }
  if (!(await worktreeExists(git, workspace.workTree, signal))) {
    await git.text(["worktree", "add", workspace.workTree, workspace.branch], { signal });
  }
  sessionWorkspaceMemo.set(sessionId, { workspace, complete: true });
  return workspace;
}

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
 * @param signal - cancellation owned by the caller, a command invocation or a
 *   tool execution, carried into every git child this call starts. The claim file
 *   is not cancellable: {@link ClaimStore} takes no signal.
 * @returns the branch and the absolute path of the tree the family works in.
 */
export async function gitStart(
  runner: Runner,
  repoRoot: string,
  sessionId: string,
  branch: string,
  worktreeName: string,
  signal?: AbortSignal,
): Promise<FamilyWorkspace> {
  const claim: Claim = {
    sessionId,
    branch,
    worktreeName,
    createdAt: new Date().toISOString(),
  };

  // The claim is written first and released before the branch is created: the
  // record is the only thing that tells a second session arriving mid-setup that
  // this tree is taken.
  const store = await ClaimStore.open(repoRoot);
  try {
    if ((await store.query(sessionId)) !== undefined) {
      throw new Error(`session ${sessionId} already holds a claim; release it with gitComplete before starting another`);
    }
    await store.append(claim);
  } finally {
    await store.dispose();
  }

  // The claim is there, so the resolution cannot come back empty — it reads the
  // record this function just wrote.
  const workspace = await ensureWorkspace(runner, repoRoot, sessionId, signal);
  if (workspace === null) throw new Error(`the claim for session ${sessionId} was not readable after it was written`);
  return workspace;
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
 * - an entry marked `complete` in the memo answers immediately: no git call, no
 *   claim file, no lock;
 * - otherwise the claim file is read for this session id — unless an incomplete
 *   entry already carries the paths it names, which saves the read and its lock
 *   on the retry path. No record means the family has no claim, which is a normal
 *   state and not an error;
 * - a recorded branch that does not exist yet is created;
 * - a recorded worktree that does not exist yet is created at
 *   `WORKTREE_ROOT/<worktreeName>` — never the main tree, which is exactly what a
 *   family is isolated from;
 * - the entry is marked `complete` only after both exist, so every step is
 *   idempotent and a failure leaves the state retryable rather than poisoned.
 *
 * @param runner - the process seam every git call goes through.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param sessionId - root of the calling session's delegation chain.
 * @param signal - cancellation owned by the caller, a command invocation or a
 *   tool execution, carried into every git child this call starts. The claim file
 *   is not cancellable: {@link ClaimStore} takes no signal.
 * @returns the branch and the absolute path of the tree the family works in, or
 *   `null` when this family holds no claim.
 */
export async function ensureWorkspace(
  runner: Runner,
  repoRoot: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<FamilyWorkspace | null> {
  const memoized = sessionWorkspaceMemo.get(sessionId);
  if (memoized === undefined) {
    // Not resolved yet, so the claim file is the only place the paths can come
    // from.
    const store = await ClaimStore.open(repoRoot);
    let workspace: FamilyWorkspace;
    try {
      const claim = await store.query(sessionId);
      if (claim === undefined) {
        sessionWorkspaceMemo.set(sessionId, null);
        return null;
      }
      workspace = { branch: claim.branch, workTree: worktreePathOf(repoRoot, claim.worktreeName) };
    } finally {
      await store.dispose();
    }
    // The paths are now known, so a failure below leaves an entry that resumes
    // instead of one that re-reads the claim file and its lock.
    const entry: MemoEntry = { workspace, complete: false };
    sessionWorkspaceMemo.set(sessionId, entry);
    return materializeWorkspace(runner, repoRoot, sessionId, entry.workspace, signal);
  }

  // `null` is the family that was asked about and holds no claim; an entry is
  // either already complete, or carries paths whose existence is still unknown.
  if (memoized === null) return null;
  if (memoized.complete) return memoized.workspace;
  return materializeWorkspace(runner, repoRoot, sessionId, memoized.workspace, signal);
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
 * @param signal - cancellation owned by the caller, a command invocation or a
 *   tool execution, carried into every git child this call starts. The claim file
 *   is not cancellable: {@link ClaimStore} takes no signal.
 * @returns what happened, in the terms the caller has to explain.
 */
export async function gitComplete(
  runner: Runner,
  repoRoot: string,
  sessionId: string,
  mergeMessage: string,
  signal?: AbortSignal,
): Promise<CompleteResult> {
  // TODO: `master` is hardcoded. Read the integration branch from configuration
  // once the rewrite needs more than this repository — the previous
  // implementation detected `origin/HEAD`, then `main`, then `master`.
  const integration = INTEGRATION_BRANCH;
  const workspace = await ensureWorkspace(runner, repoRoot, sessionId, signal);
  if (workspace === null) return { kind: "nothing-to-do" };

  const git = new GitClient(runner, repoRoot);
  let merged = false;

  // 1. merge — only when the branch still has commits the integration branch
  // does not. After a merge they are in `master`, so a retry finds nothing to
  // merge and this step skips itself.
  const ahead = await git.text(["rev-list", "--count", `${integration}..${workspace.branch}`], { signal });
  if (ahead !== "0") {
    // Merging a branch whose branch point has fallen behind `master` would bury
    // the replay inside the merge commit, so nothing is written and the caller is
    // handed the branch to replay.
    if (!(await git.ok(["merge-base", "--is-ancestor", integration, workspace.branch], { signal }))) {
      return { kind: "not-descendant", branch: workspace.branch };
    }

    // The merge runs in the tree that has `master` checked out. When nobody has
    // it — a repository whose main tree was switched away by hand — it gets one
    // of its own, outside the repository, so this never writes in another
    // family's working tree and never leaves a linked repository behind.
    let temporaryRoot: string | undefined;
    let mergeTree = await treeWithBranch(git, integration, signal);
    if (mergeTree === undefined) {
      temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-git-flow-merge-"));
      mergeTree = join(temporaryRoot, "tree");
      await git.text(["worktree", "add", mergeTree, integration], { signal });
    }

    try {
      const result = await new GitClient(runner, mergeTree).run(
        ["merge", "--no-ff", "-m", mergeMessage, workspace.branch],
        { signal },
      );
      if (result.code !== 0) {
        const error = result.stderr.trim() || result.stdout.trim() || "no output";
        return {
          kind: "failed",
          step: "merge",
          command: `git merge --no-ff -m ${mergeMessage} ${workspace.branch}`,
          error,
        };
      }
      merged = true;
    } finally {
      if (temporaryRoot !== undefined) {
        await git.run(["worktree", "remove", "--force", mergeTree], { signal }).catch(() => undefined);
        await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  // 2. remove-worktree.
  if (await worktreeExists(git, workspace.workTree, signal)) {
    const result = await git.run(["worktree", "remove", workspace.workTree], { signal });
    if (result.code !== 0) {
      return {
        kind: "failed",
        step: "remove-worktree",
        command: `git worktree remove ${workspace.workTree}`,
        error: result.stderr.trim() || result.stdout.trim() || "no output",
      };
    }
  }

  // 3. delete-branch. A claim whose branch is already gone is a retry that got
  // further than this step, so there is nothing left to delete.
  //
  // The merge is what makes the branch deletable, and it may have run in a tree
  // this process is no longer in, so the test is stated against `master` rather
  // than left to `-d`: that compares against whatever this tree's HEAD happens to
  // be, and would refuse a branch that is merged into the integration branch but
  // not into the branch checked out here. Nothing unmerged is ever deleted — the
  // forced form is reached only once the ancestor test has passed.
  if (await branchExists(git, workspace.branch, signal)) {
    if (!(await git.ok(["merge-base", "--is-ancestor", workspace.branch, integration], { signal }))) {
      return {
        kind: "failed",
        step: "delete-branch",
        command: `git merge-base --is-ancestor ${workspace.branch} ${integration}`,
        error: `'${workspace.branch}' is not merged into '${integration}'`,
      };
    }
    const result = await git.run(["branch", "-D", workspace.branch], { signal });
    if (result.code !== 0) {
      return {
        kind: "failed",
        step: "delete-branch",
        command: `git branch -D ${workspace.branch}`,
        error: result.stderr.trim() || result.stdout.trim() || "no output",
      };
    }
  }

  // 4. remove-claim — the commit point. Until the record is gone the family is
  // not finished, which is what makes a second call pick up from here.
  const store = await ClaimStore.open(repoRoot);
  try {
    await store.remove(sessionId);
  } finally {
    await store.dispose();
  }
  forgetWorkspace(sessionId);

  return { kind: "done", merged };
}

/**
 * Reclaim what unrecoverable sessions left behind.
 *
 * A session that was killed, or whose turn ended without `/git-complete`, leaves
 * a claim behind, usually with a worktree and a branch. Until that session is
 * archived it can still come back and expect its worktree to be there, so the
 * sweep is gated on recoverability rather than on liveness: the caller passes
 * what can still be resumed, and everything else is a candidate.
 *
 * Contract:
 *
 * - a claim is visited when its session id is **not** in `resumableSessionIds`
 *   **and** the claim is older than {@link CLAIM_SWEEP_AGE_MS}. Both conditions
 *   are required: unrecoverable alone is too eager — a session archived a minute
 *   ago may be resumed by the human still sitting in front of it — and old alone
 *   would take a tree from a live session;
 * - its claim record is dropped from the claim file, its memo entry is dropped,
 *   its feature branch is deleted and its worktree removed;
 * - every other claim is left exactly as it is.
 *
 * @param runner - the process seam every git call goes through.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param resumableSessionIds - session ids that can still be resumed, and whose
 *   claims are therefore off limits whatever their age. A claim outside this set
 *   belongs to a session that is archived and can no longer come back for it.
 * @param signal - cancellation owned by the caller, a command invocation or a
 *   tool execution, carried into every git child this call starts. The claim file
 *   is not cancellable: {@link ClaimStore} takes no signal, so the enumeration and
 *   the record drops run to completion even after the caller has aborted.
 */
export async function gitClean(
  runner: Runner,
  repoRoot: string,
  resumableSessionIds: readonly string[],
  signal?: AbortSignal,
): Promise<void> {
  const resumable = new Set(resumableSessionIds);
  // One cutoff for the whole sweep: a claim that crosses it mid-run would
  // otherwise be judged by when the loop reached it rather than by when the sweep
  // started, and two sweeps a second apart would disagree about it.
  const cutoff = Date.now() - CLAIM_SWEEP_AGE_MS;
  const git = new GitClient(runner, repoRoot);

  // The store is held open for the whole sweep, and nothing it does is
  // cancellable — it takes no signal. Only the git children below stop early.
  const store = await ClaimStore.open(repoRoot);
  try {
    // The file is the only place a claim can be found: a record is the sole thing
    // that names the branch and the worktree a family holds.
    for (const claim of await store.find()) {
      if (resumable.has(claim.sessionId)) continue;
      // A `createdAt` nobody can parse is a claim this sweep may not judge, and
      // the comparison already fails closed for it: `NaN < cutoff` is false.
      if (!(Date.parse(claim.createdAt) < cutoff)) continue;

      const workTree = worktreePathOf(repoRoot, claim.worktreeName);
      if (await worktreeExists(git, workTree, signal)) {
        // Forced, unlike the family's own tree in gitComplete: an abandoned
        // session's worktree is usually dirty — the edits it never committed are
        // exactly what it left behind — and a sweep that refused those would leave
        // every claim it exists for. The two gates above are what make taking that
        // work acceptable.
        const removal = await git.run(["worktree", "remove", "--force", workTree], { signal });
        // A tree git will not give up — locked, or held by a permission problem —
        // keeps its claim, so the next sweep finds it again instead of leaving a
        // branch and a tree that nothing can name.
        if (removal.code !== 0) continue;
      }
      if (await branchExists(git, claim.branch, signal)) {
        const deletion = await git.run(["branch", "-D", claim.branch], { signal });
        if (deletion.code !== 0) continue;
      }

      // The record goes last, the memo with it: this is the commit point, as in
      // gitComplete. Dropped any earlier it would take the branch and worktree
      // names with it, and a sweep that finds its work by enumerating records
      // could never see the leftovers again.
      await store.remove(claim.sessionId);
      forgetWorkspace(claim.sessionId);
    }
  } finally {
    await store.dispose();
  }
}
