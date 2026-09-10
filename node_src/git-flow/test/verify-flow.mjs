// The committed check for the two workflows. Run: pnpm test
//
// The merge semantics are the part of this plugin that is easy to get subtly
// wrong and hard to notice: a `--no-ff` merge that skipped the rebase still
// produces a merge commit, still deletes the branch, and still looks like
// success — while the history underneath it is wrong. So this file does not
// assert that `/git-complete` returned `merged`. It reads the resulting commit
// graph back out of git and asserts the shape: how many parents the merge commit
// has, what they point at, and whether the feature's own commits were replayed
// onto the new integration tip.
//
// Every case builds a real repository under a temporary directory and drives the
// BUILT lib/. Built-ins and the real `git` binary only: no harness, no profile,
// no network.
//
// What a green run does NOT mean: nothing here exercises the harness. The
// command handlers, the session-intent extraction, the system-prompt
// contribution and the pre-write guard are all outside this file — it proves the
// git operations they delegate to.
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitClient, nodeRunner } from "../lib/exec.js";
import { nodeFileAccess } from "../lib/file-access.js";
import { completeFlow, startFlow } from "../lib/flow.js";
import { commonDir, currentBranch, readLedger, writeLedger } from "../lib/repo.js";

const ROOT = ".dsh/worktrees";

const CONFIG = {
  branchPrefix: "feature/",
  integrationBranch: undefined,
  worktreeRoot: ROOT,
  useWorktreeWhenBusy: true,
  commitUncommittedBeforeMerge: true,
  mergeMessage: "Merge {branch} into {integration}",
};

let passed = 0;
const failures = [];

/**
 * Run one named case, reporting rather than throwing so every case is attempted.
 *
 * @param {string} name - what the case proves.
 * @param {() => Promise<void>} body - the case, which asserts for itself.
 */
async function verify(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message.split("\n").join("\n      ")}`);
  }
}

/**
 * Create a scratch repository with one commit on `main`.
 *
 * @returns the repository path and a git client bound to it.
 */
async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-flow-flow-"));
  const git = gitClient(nodeRunner, root);
  await git.text(["-c", "init.defaultBranch=main", "init", "-q"]);
  await git.text(["config", "user.email", "test@example.invalid"]);
  await git.text(["config", "user.name", "dsh git-flow test"]);
  await writeFile(join(root, "file.txt"), "one\n", "utf8");
  await git.text(["add", "--all"]);
  await git.text(["commit", "-q", "-m", "init"]);
  return { root, git };
}

/**
 * A flow dependency bundle for one session.
 *
 * @param git - a git client.
 * @param sessionId - the session id to act as.
 * @returns the dependency bundle.
 */
function depsFor(git, sessionId = "session-a", extra = {}) {
  return { git, files: nodeFileAccess, sessionId, pid: process.pid, config: CONFIG, ...extra };
}

/** Commit one change to a tracked file. */
async function commitChange(git, contents, message) {
  await writeFile(join(git.cwd, "file.txt"), contents, "utf8");
  await git.text(["add", "--all"]);
  await git.text(["commit", "-q", "-m", message]);
  return git.text(["rev-parse", "HEAD"]);
}

/** Commit a new, separate file — used where the integration branch must move
 * forward without colliding with the feature's own edits. */
async function commitNewFile(git, name, contents, message) {
  await writeFile(join(git.cwd, name), contents, "utf8");
  await git.text(["add", "--all"]);
  await git.text(["commit", "-q", "-m", message]);
  return git.text(["rev-parse", "HEAD"]);
}

/** Parent commit ids of a revision, in order. */
async function parents(git, rev) {
  const line = await git.text(["rev-list", "--parents", "-n", "1", rev]);
  return line.split(" ").slice(1);
}

/** Tell whether a path exists. */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

await verify("names a non-Latin prompt with the model instead of asking", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The requirement's main path, in the language that used to defeat it: a
    // Chinese prompt that clearly states the work must get a branch, not a
    // question. The mechanical rules find nothing here, so the namer answers.
    const namer = async (intent) => {
      assert.ok(intent.includes("插件"), "the namer must receive the stated intent");
      return { kind: "named", candidate: "git-flow-plugin" };
    };
    const result = await startFlow(depsFor(git, "session-a", { namer }), "我需要创建一个插件，实现 git 工作流功能");
    assert.equal(result.kind, "started", "a stated intent in another script must still be named");
    assert.equal(result.branch, "feature/git-flow-plugin");
    assert.equal(await currentBranch(git), "feature/git-flow-plugin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("does not consult the namer when the mechanical rules already named it", async () => {
  const { root, git } = await scratchRepo();
  try {
    // Naming is on the pre-write path: a model call there on every session would
    // make a free, deterministic decision slow and non-deterministic.
    let consulted = false;
    const namer = async () => {
      consulted = true;
      return { kind: "named", candidate: "should-not-be-used" };
    };
    const result = await startFlow(depsFor(git, "session-a", { namer }), "Add the login redirect");
    assert.equal(result.branch, "feature/login-redirect", "the mechanical name must win");
    assert.equal(consulted, false, "the model must not be asked when the free path succeeded");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("asks when there is no namer to consult", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The plugin without a model route still has to behave; it asks.
    const result = await startFlow(depsFor(git), "实现登录跳转");
    assert.equal(result.kind, "need-name");
    assert.equal(await currentBranch(git), "main", "and must leave the repository alone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("treats a failing or unusable namer as no name, never as an error", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A pre-write guard must not throw because a provider was unreachable, and it
    // must not accept an answer it cannot turn into a slug.
    const throwing = async () => {
      throw new Error("provider unreachable");
    };
    const first = await startFlow(depsFor(git, "session-a", { namer: throwing }), "实现登录跳转");
    assert.equal(first.kind, "need-name", "a throw must degrade to asking");
    assert.ok(first.reason.includes("unreachable"), `a throw must say so, got: ${first.reason}`);

    const prose = async () => ({ kind: "named", candidate: "I am not sure what to call this." });
    const second = await startFlow(depsFor(git, "session-a", { namer: prose }), "实现登录跳转");
    assert.equal(second.kind, "need-name", "an answer with no usable slug must degrade to asking");
    assert.ok(
      second.reason.includes("not a name"),
      `the reason must say the answer was unusable, got: ${second.reason}`,
    );
    assert.equal(await currentBranch(git), "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("does not let the model's answer repeat the branch prefix", async () => {
  const { root, git } = await scratchRepo();
  try {
    const namer = async () => ({ kind: "named", candidate: "feature/login-redirect" });
    const result = await startFlow(depsFor(git, "session-a", { namer }), "实现登录跳转");
    assert.equal(result.branch, "feature/login-redirect", "not feature/feature-login-redirect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("reports a branch a dead session left behind, instead of forgetting it", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A session that opened a branch and then died without /git-complete. The
    // record cannot be resumed, so it is dropped — but the branch is unmerged work,
    // and dropping it silently is how work goes missing.
    await git.text(["branch", "feature/abandoned"]);
    await writeLedger(git, {
      "session-dead": {
        sessionId: "session-dead",
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/abandoned",
        worktreePath: null,
        integration: "main",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
        pid: 1073741824, // above any real pid: certainly not running
        startedAt: new Date().toISOString(),
      },
    });

    const result = await startFlow(depsFor(git), "add login");
    assert.equal(result.kind, "started");
    assert.deepEqual(result.outstandingBranches, ["feature/abandoned"], "the unmerged branch must be reported");
    const ledger = await readLedger(git);
    assert.equal(ledger["session-dead"], undefined, "and its unusable record dropped");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("forgets a dead session entirely once its branch is gone", async () => {
  const { root, git } = await scratchRepo();
  try {
    const head = await git.text(["rev-parse", "HEAD"]);
    await writeLedger(git, {
      "session-dead": {
        sessionId: "session-dead",
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/deleted-already",
        worktreePath: null,
        integration: "main",
        baseCommit: head,
        pid: 1073741824,
        startedAt: new Date().toISOString(),
      },
    });

    const result = await startFlow(depsFor(git), "add login");
    assert.equal(result.kind, "started");
    assert.deepEqual(result.outstandingBranches, [], "a record with nothing left to remember is just dropped");
    assert.equal((await readLedger(git))["session-dead"], undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("does not call a live session's branch outstanding", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A session waiting for its human is idle, not finished: it is reported as
    // company (so this session is isolated), never as abandoned work.
    await git.text(["branch", "feature/in-progress"]);
    await writeLedger(git, {
      "session-live": {
        sessionId: "session-live",
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/in-progress",
        worktreePath: null,
        integration: "main",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
    });

    const result = await startFlow(depsFor(git), "add login");
    assert.equal(result.kind, "started");
    assert.equal(result.parallelSessions, 1, "a live session counts as company");
    assert.deepEqual(result.outstandingBranches, [], "and never as abandoned work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log("git flow");

await verify("derives a branch name from the session's intent", async () => {
  const { root, git } = await scratchRepo();
  try {
    const result = await startFlow(depsFor(git), "Add the login redirect");
    assert.equal(result.kind, "started");
    assert.equal(result.branch, "feature/login-redirect");
    assert.equal(result.integration, "main");
    assert.equal(result.worktreePath, null, "a lone session works in place");
    assert.equal(await currentBranch(git), "feature/login-redirect");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("asks instead of inventing a name it cannot derive", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A Chinese-only intent has no ASCII to slug. Transliterating would invent a
    // name the human never wrote, so the flow must refuse and let the caller ask.
    const result = await startFlow(depsFor(git), "实现登录跳转");
    assert.equal(result.kind, "need-name", "an unnameable intent must produce a question, not a branch");
    assert.equal(await currentBranch(git), "main", "and must leave the repository alone");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("is idempotent and never branches off a branch", async () => {
  const { root, git } = await scratchRepo();
  try {
    const first = await startFlow(depsFor(git), "add login");
    assert.equal(first.kind, "started");
    const second = await startFlow(depsFor(git), "something else entirely");
    assert.equal(second.kind, "already-on-feature", "a second /git-start must adopt, not nest");
    assert.equal(second.branch, first.branch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("merges with --no-ff when the feature is a direct descendant", async () => {
  const { root, git } = await scratchRepo();
  try {
    const base = await git.text(["rev-parse", "HEAD"]);
    await startFlow(depsFor(git), "add login");
    const featureCommit = await commitChange(git, "feature work\n", "feat: add login");

    const result = await completeFlow(depsFor(git));
    assert.equal(result.kind, "merged");
    assert.equal(result.rebased, false, "a direct descendant needs no replay");
    assert.equal(result.deletedBranch, true, "the feature branch must be deleted");

    const mergeParents = await parents(git, "main");
    assert.equal(mergeParents.length, 2, "--no-ff must produce a real merge commit with two parents");
    assert.deepEqual(mergeParents, [base, featureCommit], "the merge must join the integration tip and the feature");
    assert.equal(await currentBranch(git), "main", "the session is left on the integration branch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("replays with rebase --onto when the integration branch moved", async () => {
  const { root, git } = await scratchRepo();
  try {
    const base = await git.text(["rev-parse", "HEAD"]);
    const started = await startFlow(depsFor(git), "add login");
    assert.equal(started.kind, "started");
    const branch = started.branch;
    const featureCommit = await commitChange(git, "feature work\n", "feat: add login");

    // The integration branch moves on: this is what makes the feature a
    // non-descendant, and what a plain merge would silently mishandle.
    await git.text(["switch", "main"]);
    const integrationTip = await commitNewFile(git, "main-only.txt", "main work\n", "feat: unrelated main commit");
    await git.text(["switch", branch]);

    const result = await completeFlow(depsFor(git));
    assert.equal(result.kind, "merged");
    assert.equal(result.rebased, true, "a stale branch point must trigger the replay");
    assert.equal(result.rebasedFrom, base, "the replay must be anchored at the old merge base");

    const mergeParents = await parents(git, "main");
    assert.equal(mergeParents.length, 2, "the merge commit still has two parents");
    assert.equal(mergeParents[0], integrationTip, "the first parent must be the integration tip");
    assert.notEqual(mergeParents[1], featureCommit, "the feature commit must have been rewritten");

    // The proof that the replay really happened: the feature's commit now sits on
    // top of the new integration tip rather than beside it.
    const replayedParent = (await parents(git, mergeParents[1]))[0];
    assert.equal(replayedParent, integrationTip, "the replayed commit's parent must be the integration tip");

    const log = await git.text(["log", "--format=%s", "main"]);
    assert.ok(log.includes("feat: add login"), "the feature work must be reachable from the integration branch");
    assert.ok(log.includes("feat: unrelated main commit"), "the integration branch's own work must be preserved");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("isolates a parallel session in a worktree, and cleans it up", async () => {
  const { root, git } = await scratchRepo();
  try {
    // Another live session in the same repository: same process (so the pid check
    // cannot separate them), different session id.
    await writeLedger(git, {
      "session-other": {
        sessionId: "session-other",
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/other",
        worktreePath: null,
        integration: "main",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
        pid: process.pid,
        startedAt: new Date().toISOString(),
      },
    });

    const started = await startFlow(depsFor(git), "isolate this work");
    assert.equal(started.kind, "started");
    assert.equal(started.parallelSessions, 1);
    assert.ok(started.worktreePath !== null, "a session that arrives second must be isolated");
    assert.equal(started.ignoreChanged, true, "the worktree root must be ignored before the worktree exists");

    const gitignore = await readFile(join(root, ".gitignore"), "utf8");
    assert.ok(gitignore.includes(`${ROOT}/`), "the rule must be in the tracked .gitignore");
    assert.ok(gitignore.includes("# dsh git-flow:"), "with the comment that explains it");

    // The whole point of the guard, re-proved here through the real flow: the
    // worktree is invisible to a careless `git add --all` in the main tree.
    await git.text(["add", "--all"]);
    const staged = await git.text(["ls-files", "-s"]);
    assert.ok(!staged.includes("160000"), `no gitlink may be staged, got: ${staged}`);
    await git.text(["reset", "-q"]); // leave the index as the probe found it

    const worktreeGit = git.withCwd(started.worktreePath);
    await commitChange(worktreeGit, "isolated work\n", "feat: work in isolation");

    const result = await completeFlow(depsFor(git));
    assert.equal(result.kind, "merged");
    assert.equal(result.removedWorktree, started.worktreePath, "the session's worktree must be removed");
    assert.equal(result.deletedBranch, true);
    assert.equal(await exists(started.worktreePath), false, "the worktree directory must be gone");
    assert.equal(await currentBranch(git), "main", "the main tree stays where it was");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("reports nothing to do rather than a hollow merge commit", async () => {
  const { root, git } = await scratchRepo();
  try {
    const started = await startFlow(depsFor(git), "add login");
    assert.equal(started.kind, "started");
    const result = await completeFlow(depsFor(git));
    assert.equal(result.kind, "no-changes", "a branch with no commits must not produce a merge commit");
    assert.equal(await currentBranch(git), started.branch, "and the branch must be left intact");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("aborts a conflicted replay and leaves the branch untouched", async () => {
  const { root, git } = await scratchRepo();
  try {
    const started = await startFlow(depsFor(git), "add login");
    assert.equal(started.kind, "started");
    const branch = started.branch;
    const featureCommit = await commitChange(git, "feature version\n", "feat: add login");

    await git.text(["switch", "main"]);
    await commitChange(git, "main version\n", "feat: conflicting main commit");
    await git.text(["switch", branch]);

    const result = await completeFlow(depsFor(git));
    assert.equal(result.kind, "conflicted", "a conflict must be reported, never resolved automatically");
    assert.deepEqual(result.files, ["file.txt"]);

    assert.equal(await currentBranch(git), branch, "the feature branch must still be checked out");
    assert.equal(await git.text(["rev-parse", "HEAD"]), featureCommit, "the branch must be exactly where it started");
    const inProgress = await git.ok(["rev-parse", "--verify", "REBASE_HEAD"]);
    assert.equal(inProgress, false, "no rebase may be left in progress");
    const status = await git.text(["status", "--porcelain"]);
    assert.equal(status, "", "the working tree must be clean again");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("blocks rather than rewriting history over uncommitted work", async () => {
  const { root, git } = await scratchRepo();
  try {
    await startFlow(depsFor(git), "add login");
    await commitChange(git, "feature work\n", "feat: add login");
    await writeFile(join(root, "file.txt"), "loose change\n", "utf8");

    const blocked = await completeFlow({
      ...depsFor(git),
      config: { ...CONFIG, commitUncommittedBeforeMerge: false },
    });
    assert.equal(blocked.kind, "blocked", "loose work must stop the merge by default when so configured");
    assert.ok(blocked.reason.includes("uncommitted"), `the reason must be specific, got: ${blocked.reason}`);

    const collected = await completeFlow(depsFor(git));
    assert.equal(collected.kind, "merged");
    assert.ok(collected.collectedCommit !== undefined, "with collection enabled, the work is committed first");
    const subjects = await git.text(["log", "--format=%s", "main"]);
    assert.ok(subjects.includes("collect work in progress"), "the collected commit must be visible in history");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
