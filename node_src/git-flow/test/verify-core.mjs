/**
 * Committed checks for git-flow's core.
 *
 * The subjects are `../lib/core/core.js` and the claim store
 * `../lib/platform/claim.js` beneath it: the branch, worktree and claim decisions
 * every other part of the plugin renders. Each check drives the built modules
 * against a scratch repository and a real `git`, with the process seam supplied
 * as a plain function, so nothing here needs the harness — and nothing here mocks
 * git.
 *
 * Boundary: these checks prove what the core decides and the paths it leaves on
 * disk. They do not exercise the boundary layer (commands, tools, the write
 * guard), the claim lock (not implemented yet), or concurrency between
 * processes. Where a check pins a behaviour the module documents as out of
 * contract, its name says `characterized` so the boundary is not mistaken for a
 * promise.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-core
 */

import assert from "node:assert/strict";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace, gitClean, gitComplete, gitStart } from "../lib/core/core.js";
import { ClaimStore } from "../lib/platform/claim.js";
import { nodeRunner } from "../lib/platform/exec.js";
import { check, report, scratchRepo, signal } from "./support.mjs";

/** Where a family's worktree lives, and where the claim file is — mirrored from `core.ts`. */
const WORKTREE_ROOT = ".dsh.local/worktrees";
const CLAIM_FILE = ".dsh.local/git-flow.toml";

/** Two days, comfortably past the sweep's one-day age gate. */
const SWEEP_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Run a check body against a fresh scratch repository and remove it afterwards.
 *
 * A check that throws mid-way must still leave nothing behind, so the removal is
 * in a `finally` rather than at the end of each body.
 *
 * @param body - the check, given the repository's root and a client bound to it.
 */
async function withRepo(body) {
  const repo = await scratchRepo();
  try {
    return await body(repo);
  } finally {
    await repo.cleanup();
  }
}

/**
 * The real runner, plus every argv it was asked to run.
 *
 * This is how a check observes "no git call happened": the module never reports
 * its own call count, so it has to be counted from beneath.
 *
 * @returns the runner and the list each call's argv is appended to.
 */
function countingRunner() {
  const calls = [];
  return {
    calls,
    runner: (argv, options) => {
      calls.push([...argv]);
      return nodeRunner(argv, options);
    },
  };
}

/** Whether a path exists, without throwing when it does not. */
function exists(path) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Whether a local branch is still there. */
function branchExists(git, branch) {
  return git.ok(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/** Commit everything in one working tree, from a client bound to the repository root. */
async function commitIn(git, cwd, message) {
  await git.run(["-C", cwd, "add", "-A"]);
  await git.run(["-C", cwd, "commit", "-qm", message]);
}

/** The claim recorded for one session, read back through the store that owns the file. */
async function readClaim(root, sessionId) {
  const store = await ClaimStore.open(root);
  try {
    return await store.query(sessionId);
  } finally {
    await store.dispose();
  }
}

/**
 * Rewrite a claim's `createdAt` into the past.
 *
 * No core operation writes an old timestamp — the sweep's age gate exists
 * precisely because real claims are always fresh — so this is the only way to
 * reach the sweep with an old record.
 */
async function backdateClaim(root, sessionId, ageMs = 2 * SWEEP_AGE_MS) {
  const store = await ClaimStore.open(root);
  try {
    const claim = await store.query(sessionId);
    assert.ok(claim !== undefined, `expected a claim for ${sessionId} to backdate`);
    await store.append({ ...claim, createdAt: new Date(Date.now() - ageMs).toISOString() });
  } finally {
    await store.dispose();
  }
}

/** A private claim record reaching over `gitStart`, for the paths that begin mid-setup. */
async function writeClaim(root, claim) {
  const store = await ClaimStore.open(root);
  try {
    await store.append(claim);
  } finally {
    await store.dispose();
  }
}

/** The number of parents git reports for one commit — two for a `--no-ff` merge. */
async function parentsOf(git, rev) {
  return (await git.text(["rev-list", "--parents", "-n", "1", rev])).split(/\s+/);
}

// ---------------------------------------------------------------------------
// gitStart
// ---------------------------------------------------------------------------

await check("gitStart creates the branch, the worktree under .dsh.local/worktrees and the claim, leaving the main tree on master", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-start";
    const workspace = await gitStart(nodeRunner, root, session, "feature/start", "wt-start", signal);

    assert.equal(workspace.branch, "feature/start");
    assert.equal(workspace.workTree, join(root, WORKTREE_ROOT, "wt-start"));
    assert.ok(await branchExists(git, "feature/start"), "the feature branch exists");
    assert.ok(await exists(workspace.workTree), "the worktree directory exists");
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master", "the main tree stayed on master");

    const claim = await readClaim(root, session);
    assert.ok(claim !== undefined, "the claim was recorded");
    assert.equal(claim.branch, "feature/start");
    assert.equal(claim.worktreeName, "wt-start");
    assert.ok(!Number.isNaN(Date.parse(claim.createdAt)), "createdAt is a parseable timestamp");
  }));

await check("a second gitStart for the same session throws and creates nothing", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-start-again";
    const first = await gitStart(nodeRunner, root, session, "feature/twice", "wt-twice", signal);

    await assert.rejects(
      gitStart(nodeRunner, root, session, "feature/twice-again", "wt-twice-again", signal),
      /already holds a claim/,
    );

    assert.equal(await branchExists(git, "feature/twice-again"), false, "the refused start created no branch");
    assert.ok(await exists(first.workTree), "the first family's tree is untouched");
    assert.equal((await readClaim(root, session))?.branch, "feature/twice");
  }));

await check("gitStart overrides a memoized 'no claim' left by an earlier ensureWorkspace", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-null-memo";
    // The write guard asks first and memoizes the null; the human's /git-start
    // lands moments later. A memoized "no claim" must not outlive the claim.
    assert.equal(await ensureWorkspace(nodeRunner, root, session, signal), null);

    const workspace = await gitStart(nodeRunner, root, session, "feature/null-memo", "wt-null-memo", signal);

    assert.equal(workspace.branch, "feature/null-memo");
    assert.ok(await exists(workspace.workTree), "the worktree exists despite the earlier null");
    assert.ok(await branchExists(git, "feature/null-memo"), "the branch exists despite the earlier null");
  }));

// ---------------------------------------------------------------------------
// ensureWorkspace
// ---------------------------------------------------------------------------

await check("ensureWorkspace is null without a claim, then names the branch and absolute worktree after gitStart", () =>
  withRepo(async ({ root }) => {
    const session = "check-resolve";
    assert.equal(await ensureWorkspace(nodeRunner, root, session, signal), null);

    await gitStart(nodeRunner, root, session, "feature/resolve", "wt-resolve", signal);
    const resolved = await ensureWorkspace(nodeRunner, root, session, signal);

    assert.deepEqual(resolved, { branch: "feature/resolve", workTree: join(root, WORKTREE_ROOT, "wt-resolve") });
    assert.ok(resolved.workTree.startsWith(root), "the worktree path is absolute and inside the repository");
  }));

await check("a resolved family is answered from the memo: the second call runs no git at all", () =>
  withRepo(async ({ root }) => {
    const session = "check-memo";
    const first = await gitStart(nodeRunner, root, session, "feature/memo", "wt-memo", signal);

    const { calls, runner } = countingRunner();
    const second = await ensureWorkspace(runner, root, session, signal);

    assert.deepEqual(second, first);
    assert.deepEqual(calls, [], "the complete memo short-circuits before any git call");
  }));

await check("a half-built family is repaired on retry from its incomplete memo, without re-reading the claim file", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-repair";
    const branch = "feature/repair";
    const workTree = join(root, WORKTREE_ROOT, "wt-repair");

    // The state a setup that died after writing the claim leaves: the claim names
    // the paths, git knows the branch at most.
    await writeClaim(root, { sessionId: session, branch, worktreeName: "wt-repair", createdAt: new Date().toISOString() });

    const failing = (argv, options) =>
      argv[1] === "worktree" && argv[2] === "add"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "injected worktree failure" })
        : nodeRunner(argv, options);
    await assert.rejects(ensureWorkspace(failing, root, session, signal), /worktree add/);

    assert.ok(await branchExists(git, branch), "the branch was created before the failure");
    assert.ok(!(await exists(workTree)), "the worktree was not created");

    // A claim file the retry cannot parse. Reaching it would throw, so a successful
    // retry is the proof that the incomplete memo, not the file, supplied the paths.
    await writeFile(join(root, CLAIM_FILE), "claims = 5\n");

    const repaired = await ensureWorkspace(nodeRunner, root, session, signal);
    assert.deepEqual(repaired, { branch, workTree });
    assert.ok(await exists(workTree), "the retry recreated the missing worktree");
  }));

await check("characterized: a family torn down outside git-flow keeps its memoized answer and is not recreated", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-out-of-band";
    const workspace = await gitStart(nodeRunner, root, session, "feature/oob", "wt-oob", signal);

    // The module documents itself as the only mutator of a family's tree, and a
    // complete memo skips every git call. This pins that boundary: the recorded
    // answer comes back even though nothing is there to write in.
    await git.run(["worktree", "remove", workspace.workTree]);
    await git.run(["branch", "-D", workspace.branch]);

    assert.deepEqual(await ensureWorkspace(nodeRunner, root, session, signal), workspace);
    assert.ok(!(await exists(workspace.workTree)), "the answered path does not exist");

    // The same boundary without a memo, so it is git's registry rather than the
    // memo: git still lists a worktree whose directory was deleted as prunable, so
    // the existence test says yes and the directory is never rebuilt.
    const other = "check-out-of-band-prunable";
    const otherBranch = "feature/prunable";
    const otherTree = join(root, WORKTREE_ROOT, "wt-prunable");
    await git.run(["branch", otherBranch]);
    await git.run(["worktree", "add", otherTree, otherBranch]);
    await writeClaim(root, {
      sessionId: other,
      branch: otherBranch,
      worktreeName: "wt-prunable",
      createdAt: new Date().toISOString(),
    });
    await rm(otherTree, { recursive: true, force: true });

    assert.deepEqual(await ensureWorkspace(nodeRunner, root, other, signal), { branch: otherBranch, workTree: otherTree });
    assert.ok(!(await exists(otherTree)), "the registered path outlived its directory and was answered as-is");
  }));

// ---------------------------------------------------------------------------
// gitComplete
// ---------------------------------------------------------------------------

await check("gitComplete merges --no-ff in the master tree, then removes the worktree, branch and claim", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-complete";
    const branch = "feature/complete";
    const message = "Merge feature/complete into master";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-complete", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");
    const mainBefore = await git.text(["rev-parse", "HEAD"]);

    const result = await gitComplete(nodeRunner, root, session, message, signal);

    assert.deepEqual(result, { kind: "done", merged: true });
    const mergeCommit = await parentsOf(git, "master");
    assert.equal(mergeCommit.length, 3, "the merge commit has two parents");
    assert.equal(await git.text(["log", "-1", "--format=%s", "master"]), message);
    assert.equal(await git.text(["show", "master:topic.txt"]), "topic", "the branch's file is on master");
    // The main tree is where master was checked out, so its own HEAD is the merge.
    assert.equal(await git.text(["rev-parse", "HEAD"]), mergeCommit[0]);
    assert.notEqual(mergeCommit[0], mainBefore);

    assert.ok(!(await exists(workspace.workTree)), "the worktree is gone");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("gitComplete is re-entrant: a second call reports nothing-to-do", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-complete-twice";
    const workspace = await gitStart(nodeRunner, root, session, "feature/again", "wt-again", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");

    assert.deepEqual(await gitComplete(nodeRunner, root, session, "Merge again", signal), { kind: "done", merged: true });
    assert.deepEqual(await gitComplete(nodeRunner, root, session, "Merge again", signal), { kind: "nothing-to-do" });
  }));

await check("gitComplete on a family with nothing ahead reports done with merged:false and still cleans up", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-complete-empty";
    const branch = "feature/empty";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-empty", signal);

    const result = await gitComplete(nodeRunner, root, session, "nothing to merge", signal);

    assert.deepEqual(result, { kind: "done", merged: false });
    assert.ok(!(await exists(workspace.workTree)), "the worktree is gone");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("gitComplete reports not-descendant and writes and deletes nothing when master moved past the branch point", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-diverged";
    const branch = "feature/diverged";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-diverged", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");

    // master advances on its own, so the branch's branch point falls behind it.
    await writeFile(join(root, "main.txt"), "main\n");
    await git.run(["add", "-A"]);
    await git.run(["commit", "-qm", "advance master"]);
    const masterBefore = await git.text(["rev-parse", "master"]);

    const result = await gitComplete(nodeRunner, root, session, "should never run", signal);

    assert.deepEqual(result, { kind: "not-descendant", branch });
    assert.equal(await git.text(["rev-parse", "master"]), masterBefore, "master did not move");
    assert.equal(await git.text(["log", "-1", "--format=%s", "master"]), "advance master", "no merge landed");
    assert.ok(await exists(workspace.workTree), "the worktree survives");
    assert.ok(await branchExists(git, branch), "the branch survives");
    assert.ok((await readClaim(root, session)) !== undefined, "the claim survives");
  }));

await check("a dirty worktree fails gitComplete at remove-worktree after the merge, and the claim survives", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-dirty";
    const branch = "feature/dirty";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-dirty", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");
    // Uncommitted work is exactly what makes a bare `git worktree remove` refuse.
    await writeFile(join(workspace.workTree, "leftover.txt"), "leftover\n");

    const result = await gitComplete(nodeRunner, root, session, "Merge dirty", signal);

    assert.equal(result.kind, "failed");
    assert.equal(result.step, "remove-worktree");
    assert.equal(result.command, `git worktree remove ${workspace.workTree}`);
    assert.match(result.error, /force|untracked|modified/i);
    // The merge already ran, which is what makes the failed step safe to retry.
    assert.equal((await parentsOf(git, "master")).length, 3, "the merge commit is on master");
    assert.ok(await exists(workspace.workTree), "the dirty worktree is still there");
    assert.ok(await branchExists(git, branch), "the branch is still there");
    assert.ok((await readClaim(root, session)) !== undefined, "the claim survives so a retry can finish");
  }));

await check("the completion finishes on a retry once the worktree is clean again", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-dirty-retry";
    const branch = "feature/dirty-retry";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-dirty-retry", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");
    await writeFile(join(workspace.workTree, "leftover.txt"), "leftover\n");
    assert.equal((await gitComplete(nodeRunner, root, session, "Merge dirty", signal)).step, "remove-worktree");

    await rm(join(workspace.workTree, "leftover.txt"));
    const retry = await gitComplete(nodeRunner, root, session, "Merge dirty", signal);

    assert.deepEqual(retry, { kind: "done", merged: false }, "the merge is behind it, so nothing is merged again");
    assert.ok(!(await exists(workspace.workTree)), "the worktree is gone");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("characterized: a retry that commits the leftover work reports not-descendant instead of finishing", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-dirty-commit";
    const branch = "feature/dirty-commit";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-dirty-commit", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");
    await writeFile(join(workspace.workTree, "leftover.txt"), "leftover\n");
    assert.equal((await gitComplete(nodeRunner, root, session, "Merge dirty", signal)).step, "remove-worktree");

    // Committing the leftover puts a commit on the branch whose parent is the
    // pre-merge head; master now carries the merge commit, which is not an ancestor
    // of it, so the core refuses to merge again and asks for the replay instead.
    await commitIn(git, workspace.workTree, "leftover");
    const retry = await gitComplete(nodeRunner, root, session, "Merge dirty", signal);

    assert.equal(retry.kind, "not-descendant");
    assert.ok((await readClaim(root, session)) !== undefined, "the claim survives the refusal");
  }));

await check("when no tree holds master the merge runs in a temporary worktree and does not hijack the main tree", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-fallback";
    const branch = "feature/fallback";
    const message = "Merge fallback";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-fallback", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");

    // Move the main tree off master: no working tree has it checked out now.
    await git.run(["checkout", "-q", "-b", "side"]);
    const tmpBefore = new Set(await readdir(tmpdir()));

    const result = await gitComplete(nodeRunner, root, session, message, signal);

    assert.deepEqual(result, { kind: "done", merged: true });
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "side", "the main tree was not merged into");
    assert.equal((await parentsOf(git, "master")).length, 3, "the merge commit is on master");
    assert.equal(await git.text(["show", "master:topic.txt"]), "topic", "the branch's file is on master");
    const leftovers = (await readdir(tmpdir())).filter((name) => name.startsWith("dsh-git-flow-merge-") && !tmpBefore.has(name));
    assert.deepEqual(leftovers, [], "the temporary merge worktree was taken away");
    assert.ok(!(await exists(workspace.workTree)), "the worktree is gone");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

// ---------------------------------------------------------------------------
// gitClean
// ---------------------------------------------------------------------------

await check("gitClean sweeps an old claim for a non-resumable session, dirty worktree and all", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean";
    const branch = "feature/clean";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-clean", signal);
    await writeFile(join(workspace.workTree, "leftover.txt"), "leftover\n");
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.ok(!(await exists(workspace.workTree)), "the worktree is swept");
    assert.equal(await branchExists(git, branch), false, "the branch is swept");
    assert.equal(await readClaim(root, session), undefined, "the claim is swept");
    // The memo went with the record: a later question reads the file and finds nothing.
    assert.equal(await ensureWorkspace(nodeRunner, root, session, signal), null, "the memo entry was dropped");
  }));

await check("gitClean leaves a fresh claim for a non-resumable session alone (the age gate)", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-fresh";
    const branch = "feature/fresh";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-fresh", signal);

    await gitClean(nodeRunner, root, [], signal);

    assert.ok(await exists(workspace.workTree), "a claim younger than a day is untouched");
    assert.ok(await branchExists(git, branch));
    assert.ok((await readClaim(root, session)) !== undefined);
  }));

await check("gitClean leaves an old claim for a resumable session alone (the resumability gate)", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-resumable";
    const branch = "feature/resumable";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-resumable", signal);
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [session], signal);

    assert.ok(await exists(workspace.workTree), "a claim a session can come back for is untouched");
    assert.ok(await branchExists(git, branch));
    assert.ok((await readClaim(root, session)) !== undefined);
  }));

await check("gitClean sweeps a claim whose worktree directory is already gone but git still registers", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-missing-tree";
    const branch = "feature/missing-tree";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-missing-tree", signal);
    await rm(workspace.workTree, { recursive: true, force: true });
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await branchExists(git, branch), false, "the branch is swept");
    assert.equal(await readClaim(root, session), undefined, "the claim is swept");
  }));

await check("gitClean sweeps a claim whose branch and worktree are both already gone, without throwing", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-gone";
    const branch = "feature/gone";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-gone", signal);
    await git.run(["worktree", "remove", workspace.workTree]);
    await git.run(["branch", "-D", branch]);
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await readClaim(root, session), undefined, "the record is dropped all the same");
  }));

await check("gitClean deletes a branch master has never seen: it trusts the claim, not an ancestry test", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-unmerged";
    const branch = "feature/unmerged";
    const workspace = await gitStart(nodeRunner, root, session, branch, "wt-unmerged", signal);
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitIn(git, workspace.workTree, "topic work");
    // The worktree goes first: a branch that is checked out cannot be deleted.
    await git.run(["worktree", "remove", workspace.workTree]);
    assert.ok(await branchExists(git, branch));
    assert.equal(await git.ok(["merge-base", "--is-ancestor", branch, "master"]), false, "the branch is unmerged");
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await branchExists(git, branch), false, "the unmerged branch was deleted anyway");
    assert.equal(await readClaim(root, session), undefined, "the claim is swept");
  }));

report();
