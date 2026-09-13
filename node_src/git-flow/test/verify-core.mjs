/**
 * Committed checks for git-flow's core.
 *
 * The subjects are `../lib/core/core.js` and the claim store
 * `../lib/platform/claim.js` beneath it: the branch, tree and claim decisions
 * every other part of the plugin renders. Each check drives the built modules
 * against a scratch repository and a real `git`, with the process seam supplied
 * as a plain function, so nothing here needs the harness — and nothing here mocks
 * git.
 *
 * A family works in one of two shapes, and both are checked. A repository whose
 * main tree nobody holds is worked **in place** — the common case, which is why
 * most checks start that way — and a family that arrives while another resumable
 * family holds the main tree gets a **worktree of its own**. Where a check wants
 * the second shape without re-enacting the reason for it, it writes the claim and
 * resolves it: the decision itself has a check of its own.
 *
 * Boundary: these checks prove what the core decides and the paths it leaves on
 * disk. They do not exercise the boundary layer (commands, tools, the write
 * guard), the claim lock — which `verify-claim.mjs` checks, a second process
 * included — or concurrency between processes beyond it. Where a check pins a
 * behaviour the module documents as out of contract, its name says `characterized`
 * so the boundary is not mistaken for a promise.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-core
 */

import assert from "node:assert/strict";
import { readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureWorkspace, gitClean, gitComplete, gitStart } from "../lib/core/core.js";
import { ClaimStore, MAIN_WORKTREE } from "../lib/platform/claim.js";
import { nodeRunner } from "../lib/platform/exec.js";
import { check, commitFile, occupyMainTree, report, scratchRepo, signal } from "./support.mjs";

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

/**
 * Start a family in a repository whose main tree is free.
 *
 * No resumable session is listed, so the family takes the main tree — which is
 * what makes `[MAIN]` the shape of the ordinary case rather than a special one.
 *
 * @param root - the scratch repository's root.
 * @param session - the family's session id.
 * @param branch - the feature branch to open.
 * @returns the workspace the family works in.
 */
function startInPlace(root, session, branch) {
  return gitStart(nodeRunner, root, session, branch, [], signal);
}

/**
 * Start a family that is isolated in a worktree of its own.
 *
 * The claim is written and resolved directly rather than through `gitStart`: that
 * decision has its own check, and every other check wants the shape without
 * re-enacting the reason for it.
 *
 * @param root - the scratch repository's root.
 * @param session - the family's session id.
 * @param branch - the feature branch to open.
 * @param worktreeName - the directory name under the worktree root.
 * @returns the workspace the family works in.
 */
async function startWorktree(root, session, branch, worktreeName) {
  await writeClaim(root, { sessionId: session, branch, worktreeName, createdAt: new Date().toISOString() });
  const workspace = await ensureWorkspace(nodeRunner, root, session, signal);
  assert.ok(workspace !== null, `the claim for ${session} did not resolve`);
  return workspace;
}

// ---------------------------------------------------------------------------
// gitStart
// ---------------------------------------------------------------------------

await check("gitStart in a free repository takes the main tree and records [MAIN]", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-start-main";
    const branch = "feat/start-main";
    const workspace = await startInPlace(root, session, branch);

    assert.equal(workspace.branch, branch);
    assert.equal(workspace.workTree, root, "the family works in the repository's own tree");
    assert.ok(await branchExists(git, branch), "the feature branch exists");
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), branch, "the main tree is on the branch");
    assert.equal(await exists(join(root, WORKTREE_ROOT)), false, "no worktree root was created at all");

    const claim = await readClaim(root, session);
    assert.ok(claim !== undefined, "the claim was recorded");
    assert.equal(claim.branch, branch);
    assert.equal(claim.worktreeName, MAIN_WORKTREE);
    assert.ok(!Number.isNaN(Date.parse(claim.createdAt)), "createdAt is a parseable timestamp");
  }));

await check("a family that arrives while another resumable family holds the main tree gets a worktree cut from master", () =>
  withRepo(async ({ root, git }) => {
    const holder = await occupyMainTree(root, "check-holder");
    // The holder is *in* the main tree, so the tree stands on the holder's branch —
    // which is exactly what a second family must not be branched off.
    await git.run(["switch", "-c", `feat/${holder}`]);
    await writeFile(join(root, "held.txt"), "held\n");
    await commitFile(git, root, "held.txt", "the holder's work");
    const held = await git.text(["rev-parse", "HEAD"]);
    const master = await git.text(["rev-parse", "master"]);
    assert.notEqual(held, master, "the holder's branch is ahead of master");

    const session = "check-isolated";
    const branch = "feat/isolated";
    const workspace = await gitStart(nodeRunner, root, session, branch, [holder], signal);

    assert.equal(workspace.workTree, join(root, WORKTREE_ROOT, "isolated"));
    assert.ok(await exists(workspace.workTree), "the worktree directory exists");
    assert.equal(await git.text(["rev-parse", branch]), master, "the branch was cut from master, not from HEAD");
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), `feat/${holder}`, "the holder was not moved");
    assert.equal((await readClaim(root, session))?.worktreeName, "isolated");
  }));

await check("two families at once: the second is isolated, and releasing it leaves the first alone", () =>
  withRepo(async ({ root, git }) => {
    const first = "check-concurrent-a";
    const second = "check-concurrent-b";
    const firstBranch = "feat/concurrent-a";
    const secondBranch = "feat/concurrent-b";

    const held = await startInPlace(root, first, firstBranch);
    assert.equal(held.workTree, root, "the first family took the main tree");

    // The first family is resumable and holds the main tree, so the second goes
    // out — which is the whole reason a worktree exists at all.
    const isolated = await gitStart(nodeRunner, root, second, secondBranch, [first, second], signal);
    assert.equal(isolated.workTree, join(root, WORKTREE_ROOT, "concurrent_b"));
    await writeFile(join(isolated.workTree, "topic.txt"), "topic\n");
    await commitFile(git, isolated.workTree, "topic.txt", "the second family's work");

    const result = await gitComplete(nodeRunner, root, second, "Merge the second family", signal);

    assert.deepEqual(result, { kind: "done", merged: true });
    assert.equal(await branchExists(git, secondBranch), false, "the second family's branch was released");
    assert.equal(await readClaim(root, second), undefined, "the second family's claim was released");
    // The first family is untouched: its branch, its claim, and the main tree it
    // holds — the last of which the memo answers without a single git call.
    assert.ok(await branchExists(git, firstBranch), "the first family's branch survives");
    assert.equal((await readClaim(root, first))?.worktreeName, MAIN_WORKTREE);
    assert.deepEqual(await ensureWorkspace(nodeRunner, root, first, signal), held);
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), firstBranch, "the main tree is still the first family's");
  }));

await check("the main tree is free again when its holder can no longer come back", () =>
  withRepo(async ({ root }) => {
    // The record is in the file, but the session is not in the resumable set: a
    // leftover the sweep will collect, not a reason to exile the next family.
    await occupyMainTree(root, "check-stale-holder");
    const session = "check-after-stale";
    const workspace = await gitStart(nodeRunner, root, session, "feat/after-stale", [], signal);

    assert.equal(workspace.workTree, root);
    assert.equal((await readClaim(root, session))?.worktreeName, MAIN_WORKTREE);
  }));

await check("a second gitStart for the same session throws and creates nothing", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-start-again";
    const first = await startInPlace(root, session, "feat/twice");
    const head = await git.text(["rev-parse", "--abbrev-ref", "HEAD"]);

    await assert.rejects(gitStart(nodeRunner, root, session, "feat/twice-again", [], signal), /already holds a claim/);

    assert.equal(await branchExists(git, "feat/twice-again"), false, "the refused start created no branch");
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), head, "the checkout was not moved");
    assert.equal((await readClaim(root, session))?.branch, "feat/twice");
    assert.equal(first.workTree, root);
  }));

await check("gitStart overrides a memoized 'no claim' left by an earlier ensureWorkspace", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-null-memo";
    // The write guard asks first and memoizes the null; the human's /git-start
    // lands moments later. A memoized "no claim" must not outlive the claim.
    assert.equal(await ensureWorkspace(nodeRunner, root, session, signal), null);

    const workspace = await gitStart(nodeRunner, root, session, "feat/null-memo", [], signal);

    assert.equal(workspace.branch, "feat/null-memo");
    assert.equal(workspace.workTree, root, "the memoized null did not stop the main tree from being taken");
    assert.ok(await branchExists(git, "feat/null-memo"), "the branch exists despite the earlier null");
  }));

// ---------------------------------------------------------------------------
// ensureWorkspace
// ---------------------------------------------------------------------------

await check("ensureWorkspace is null without a claim, then names the branch and the main tree after a start", () =>
  withRepo(async ({ root }) => {
    const session = "check-resolve-main";
    assert.equal(await ensureWorkspace(nodeRunner, root, session, signal), null);

    await startInPlace(root, session, "feat/resolve-main");
    const resolved = await ensureWorkspace(nodeRunner, root, session, signal);

    assert.deepEqual(resolved, { branch: "feat/resolve-main", workTree: root });
  }));

await check("ensureWorkspace resolves a worktree claim to WORKTREE_ROOT/<name>", () =>
  withRepo(async ({ root }) => {
    const session = "check-resolve-tree";
    const resolved = await startWorktree(root, session, "feat/resolve-tree", "wt-resolve-tree");

    assert.deepEqual(resolved, {
      branch: "feat/resolve-tree",
      workTree: join(root, WORKTREE_ROOT, "wt-resolve-tree"),
    });
    assert.ok(resolved.workTree.startsWith(root), "the worktree path is absolute and inside the repository");
  }));

await check("a resolved family is answered from the memo: the second call runs no git at all", () =>
  withRepo(async ({ root }) => {
    const session = "check-memo";
    const first = await startInPlace(root, session, "feat/memo");

    const { calls, runner } = countingRunner();
    const second = await ensureWorkspace(runner, root, session, signal);

    assert.deepEqual(second, first);
    assert.deepEqual(calls, [], "the complete memo short-circuits before any git call");
  }));

await check("a half-built family is repaired on retry from its incomplete memo, without re-reading the claim file", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-repair";
    const branch = "feat/repair";
    const workTree = join(root, WORKTREE_ROOT, "wt-repair");

    // The state a setup that died before git did anything leaves: the claim names
    // the paths and neither of them exists. A worktree family's branch is made by
    // the same `worktree add` as its tree, so a failure leaves both undone.
    await writeClaim(root, {
      sessionId: session,
      branch,
      worktreeName: "wt-repair",
      createdAt: new Date().toISOString(),
    });

    const failing = (argv, options) =>
      argv[1] === "worktree" && argv[2] === "add"
        ? Promise.resolve({ code: 1, stdout: "", stderr: "injected worktree failure" })
        : nodeRunner(argv, options);
    await assert.rejects(ensureWorkspace(failing, root, session, signal), /worktree add/);

    assert.equal(await branchExists(git, branch), false, "the branch went down with the worktree that makes it");
    assert.equal(await exists(workTree), false, "the worktree was not created");

    // A claim file the retry cannot parse. Reaching it would throw, so a successful
    // retry is the proof that the incomplete memo, not the file, supplied the paths.
    await writeFile(join(root, CLAIM_FILE), "claims = 5\n");

    const repaired = await ensureWorkspace(nodeRunner, root, session, signal);
    assert.deepEqual(repaired, { branch, workTree });
    assert.ok(await exists(workTree), "the retry created the missing worktree");
    assert.ok(await branchExists(git, branch), "the retry created the missing branch too");
  }));

await check("characterized: a family torn down outside git-flow keeps its memoized answer and is not recreated", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-out-of-band";
    const workspace = await startWorktree(root, session, "feat/oob", "wt-oob");

    // The module documents itself as the only mutator of a family's tree, and a
    // complete memo skips every git call. This pins that boundary: the recorded
    // answer comes back even though nothing is there to write in.
    await git.run(["worktree", "remove", workspace.workTree]);
    await git.run(["branch", "-D", workspace.branch]);

    assert.deepEqual(await ensureWorkspace(nodeRunner, root, session, signal), workspace);
    assert.equal(await exists(workspace.workTree), false, "the answered path does not exist");

    // The same boundary without a memo, so it is git's registry rather than the
    // memo: git still lists a worktree whose directory was deleted as prunable, so
    // the existence test says yes and the directory is never rebuilt.
    const other = "check-out-of-band-prunable";
    const otherBranch = "feat/prunable";
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
    assert.equal(await exists(otherTree), false, "the registered path outlived its directory and was answered as-is");
  }));

// ---------------------------------------------------------------------------
// gitComplete
// ---------------------------------------------------------------------------

await check("gitComplete in place: the merge lands on master and the main tree goes back to master", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-complete-main";
    const branch = "feat/complete-main";
    const message = "Merge feat/complete-main into master";
    const workspace = await startInPlace(root, session, branch);
    assert.equal(workspace.workTree, root);

    await writeFile(join(root, "topic.txt"), "topic\n");
    await commitFile(git, root, "topic.txt", "topic work");
    const branchTip = await git.text(["rev-parse", "HEAD"]);
    const masterBefore = await git.text(["rev-parse", "master"]);
    assert.notEqual(branchTip, masterBefore, "the family has a commit master does not");

    const result = await gitComplete(nodeRunner, root, session, message, signal);

    assert.deepEqual(result, { kind: "done", merged: true });
    // No tree held master while the family was in place, so the merge ran in a
    // temporary tree and this switch is what puts the human back where the next
    // /git-start expects to begin.
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master", "the main tree went back");
    assert.equal((await parentsOf(git, "master")).length, 3, "the merge commit has two parents");
    assert.equal(await git.text(["log", "-1", "--format=%s", "master"]), message);
    assert.equal(await git.text(["show", "master:topic.txt"]), "topic", "the branch's file is on master");
    assert.equal(await git.text(["rev-parse", "HEAD"]), await git.text(["rev-parse", "master"]));
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("characterized: gitComplete reports switch-back when git refuses to move the main tree", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-switch-back";
    const branch = "feat/blocked-back";
    await startInPlace(root, session, branch);
    await writeFile(join(root, "topic.txt"), "topic\n");
    await commitFile(git, root, "topic.txt", "topic work");

    // A stale index lock is how a git checkout is made to refuse on demand: any
    // command that writes this tree's index fails at the same point, and the
    // release — whose merge has already happened — stops on the step that moves the
    // tree. The merge itself runs in a linked worktree, which has its own index.
    const lock = join(root, ".git", "index.lock");
    await writeFile(lock, "");

    const result = await gitComplete(nodeRunner, root, session, "Merge blocked", signal);

    assert.equal(result.kind, "failed");
    assert.equal(result.step, "switch-back");
    assert.equal(result.command, "git switch master");
    assert.match(result.error, /index\.lock/i);
    // The merge ran before the step that failed, so a retry has only this left.
    assert.equal((await parentsOf(git, "master")).length, 3, "the merge commit is on master");
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), branch, "the tree is still on the branch");
    assert.ok(await branchExists(git, branch), "the branch is still there");
    assert.ok((await readClaim(root, session)) !== undefined, "the claim survives so a retry can finish");

    await rm(lock);
    const retry = await gitComplete(nodeRunner, root, session, "Merge blocked", signal);

    assert.deepEqual(retry, { kind: "done", merged: false }, "the merge is behind it");
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("gitComplete for a worktree family merges --no-ff in the master tree, then removes the worktree, branch and claim", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-complete";
    const branch = "feat/complete";
    const message = "Merge feature/complete into master";
    const workspace = await startWorktree(root, session, branch, "wt-complete");
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitFile(git, workspace.workTree, "topic.txt", "topic work");
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

    assert.equal(await exists(workspace.workTree), false, "the worktree is gone");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("gitComplete is re-entrant: a second call reports nothing-to-do", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-complete-twice";
    await startInPlace(root, session, "feat/again");
    await writeFile(join(root, "topic.txt"), "topic\n");
    await commitFile(git, root, "topic.txt", "topic work");

    assert.deepEqual(await gitComplete(nodeRunner, root, session, "Merge again", signal), { kind: "done", merged: true });
    assert.deepEqual(await gitComplete(nodeRunner, root, session, "Merge again", signal), { kind: "nothing-to-do" });
  }));

await check("gitComplete on a family with nothing ahead reports done with merged:false and still cleans up", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-complete-empty";
    const branch = "feat/empty";
    await startInPlace(root, session, branch);

    const result = await gitComplete(nodeRunner, root, session, "nothing to merge", signal);

    assert.deepEqual(result, { kind: "done", merged: false });
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master", "the main tree went back");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("gitComplete reports not-descendant and writes and deletes nothing when master moved past the branch point", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-diverged";
    const branch = "feat/diverged";
    const workspace = await startWorktree(root, session, branch, "wt-diverged");
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitFile(git, workspace.workTree, "topic.txt", "topic work");

    // master advances on its own, so the branch's branch point falls behind it.
    await writeFile(join(root, "main.txt"), "main\n");
    await commitFile(git, root, "main.txt", "advance master");
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
    const branch = "feat/dirty";
    const workspace = await startWorktree(root, session, branch, "wt-dirty");
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitFile(git, workspace.workTree, "topic.txt", "topic work");
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
    const branch = "feat/dirty-retry";
    const workspace = await startWorktree(root, session, branch, "wt-dirty-retry");
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitFile(git, workspace.workTree, "topic.txt", "topic work");
    await writeFile(join(workspace.workTree, "leftover.txt"), "leftover\n");
    assert.equal((await gitComplete(nodeRunner, root, session, "Merge dirty", signal)).step, "remove-worktree");

    await rm(join(workspace.workTree, "leftover.txt"));
    const retry = await gitComplete(nodeRunner, root, session, "Merge dirty", signal);

    assert.deepEqual(retry, { kind: "done", merged: false }, "the merge is behind it, so nothing is merged again");
    assert.equal(await exists(workspace.workTree), false, "the worktree is gone");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("characterized: a retry that commits the leftover work reports not-descendant instead of finishing", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-dirty-commit";
    const branch = "feat/dirty-commit";
    const workspace = await startWorktree(root, session, branch, "wt-dirty-commit");
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitFile(git, workspace.workTree, "topic.txt", "topic work");
    await writeFile(join(workspace.workTree, "leftover.txt"), "leftover\n");
    assert.equal((await gitComplete(nodeRunner, root, session, "Merge dirty", signal)).step, "remove-worktree");

    // Committing the leftover puts a commit on the branch whose parent is the
    // pre-merge head; master now carries the merge commit, which is not an ancestor
    // of it, so the core refuses to merge again and asks for the replay instead.
    await commitFile(git, workspace.workTree, "leftover.txt", "leftover");
    const retry = await gitComplete(nodeRunner, root, session, "Merge dirty", signal);

    assert.equal(retry.kind, "not-descendant");
    assert.ok((await readClaim(root, session)) !== undefined, "the claim survives the refusal");
  }));

await check("when no tree holds master the merge runs in a temporary worktree and does not hijack the main tree", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-fallback";
    const branch = "feat/fallback";
    const message = "Merge fallback";
    const workspace = await startWorktree(root, session, branch, "wt-fallback");
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitFile(git, workspace.workTree, "topic.txt", "topic work");

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
    assert.equal(await exists(workspace.workTree), false, "the worktree is gone");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

await check("an in-place family whose tree has moved on is released without moving that tree", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-moved-on";
    const branch = "feat/moved-on";
    await startInPlace(root, session, branch);
    await writeFile(join(root, "topic.txt"), "topic\n");
    await commitFile(git, root, "topic.txt", "topic work");

    // The human switched the tree away by hand. The release still happens, and the
    // switch back is skipped precisely because the tree is not on the branch.
    await git.run(["switch", "-q", "-c", "side", "master"]);

    const result = await gitComplete(nodeRunner, root, session, "Merge moved-on", signal);

    assert.deepEqual(result, { kind: "done", merged: true });
    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "side", "the tree was left where it was");
    assert.equal((await parentsOf(git, "master")).length, 3, "the merge commit is on master");
    assert.equal(await branchExists(git, branch), false, "the branch is gone");
    assert.equal(await readClaim(root, session), undefined, "the claim is gone");
  }));

// ---------------------------------------------------------------------------
// gitClean
// ---------------------------------------------------------------------------

await check("gitClean sweeps an in-place claim: the main tree goes back to master and the branch is deleted", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-main";
    const branch = "feat/clean-main";
    await startInPlace(root, session, branch);
    await writeFile(join(root, "leftover.txt"), "leftover\n");
    await commitFile(git, root, "leftover.txt", "work the session never merged");
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master", "the main tree was put back");
    assert.equal(await branchExists(git, branch), false, "the branch is swept, merged or not");
    assert.equal(await readClaim(root, session), undefined, "the claim is swept");
    // The memo went with the record: a later question reads the file and finds nothing.
    assert.equal(await ensureWorkspace(nodeRunner, root, session, signal), null, "the memo entry was dropped");
  }));

await check("gitClean sweeps an in-place claim whose tree has moved on, without touching that tree", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-moved";
    const branch = "feat/clean-moved";
    await startInPlace(root, session, branch);
    await writeFile(join(root, "topic.txt"), "topic\n");
    await commitFile(git, root, "topic.txt", "work the session never merged");
    await git.run(["switch", "-q", "-c", "side", "master"]);
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "side", "the tree was left where it was");
    assert.equal(await branchExists(git, branch), false, "the branch is swept");
    assert.equal(await readClaim(root, session), undefined, "the claim is swept");
  }));

await check("gitClean leaves a fresh claim for a non-resumable session alone (the age gate)", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-fresh";
    const branch = "feat/fresh";
    await startInPlace(root, session, branch);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), branch, "a claim younger than a day is untouched");
    assert.ok(await branchExists(git, branch));
    assert.ok((await readClaim(root, session)) !== undefined);
  }));

await check("gitClean leaves an old claim for a resumable session alone (the resumability gate)", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-resumable";
    const branch = "feat/resumable";
    await startInPlace(root, session, branch);
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [session], signal);

    assert.equal(await git.text(["rev-parse", "--abbrev-ref", "HEAD"]), branch, "a claim a session can come back for is untouched");
    assert.ok(await branchExists(git, branch));
    assert.ok((await readClaim(root, session)) !== undefined);
  }));

await check("gitClean sweeps an old claim for a non-resumable session, dirty worktree and all", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean";
    const branch = "feat/clean";
    const workspace = await startWorktree(root, session, branch, "wt-clean");
    await writeFile(join(workspace.workTree, "leftover.txt"), "leftover\n");
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await exists(workspace.workTree), false, "the worktree is swept");
    assert.equal(await branchExists(git, branch), false, "the branch is swept");
    assert.equal(await readClaim(root, session), undefined, "the claim is swept");
    assert.equal(await ensureWorkspace(nodeRunner, root, session, signal), null, "the memo entry was dropped");
  }));

await check("gitClean sweeps a claim whose worktree directory is already gone but git still registers", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-missing-tree";
    const branch = "feat/missing-tree";
    const workspace = await startWorktree(root, session, branch, "wt-missing-tree");
    await rm(workspace.workTree, { recursive: true, force: true });
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await branchExists(git, branch), false, "the branch is swept");
    assert.equal(await readClaim(root, session), undefined, "the claim is swept");
  }));

await check("gitClean sweeps a claim whose branch and worktree are both already gone, without throwing", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-gone";
    const branch = "feat/gone";
    const workspace = await startWorktree(root, session, branch, "wt-gone");
    await git.run(["worktree", "remove", workspace.workTree]);
    await git.run(["branch", "-D", branch]);
    await backdateClaim(root, session);

    await gitClean(nodeRunner, root, [], signal);

    assert.equal(await readClaim(root, session), undefined, "the record is dropped all the same");
  }));

await check("gitClean deletes a branch master has never seen: it trusts the claim, not an ancestry test", () =>
  withRepo(async ({ root, git }) => {
    const session = "check-clean-unmerged";
    const branch = "feat/unmerged";
    const workspace = await startWorktree(root, session, branch, "wt-unmerged");
    await writeFile(join(workspace.workTree, "topic.txt"), "topic\n");
    await commitFile(git, workspace.workTree, "topic.txt", "topic work");
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
