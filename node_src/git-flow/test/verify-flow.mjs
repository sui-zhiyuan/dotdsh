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
import { cleanupFlow } from "../lib/cleanup.js";
import { completeFlow, startFlow } from "../lib/flow.js";
import { commonDir, currentBranch, readLedger, writeLedger } from "../lib/repo.js";

const ROOT = ".dsh.local/worktrees";

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
 * A claim record for seeding the ledger.
 *
 * @param sessionId - the family the claim belongs to.
 * @param overrides - the fields this case cares about.
 * @returns a complete claim.
 */
function claim(sessionId, overrides = {}) {
  return {
    sessionId,
    repoKey: "",
    repoRoot: "",
    tree: "main",
    worktreePath: null,
    branch: null,
    integration: null,
    baseCommit: null,
    pid: process.pid,
    claimedAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * A session registry stub in which the listed ids are resident.
 *
 * Liveness is not a pid question any more, so a case that wants a peer to count
 * has to say *why* it is live: resident here, or a live pid in another process.
 *
 * @param resident - session ids present in this process.
 * @returns the registry slice the plugin reads.
 */
function registryOf(...resident) {
  return { get: (id) => (resident.includes(id) ? { id } : undefined) };
}

/**
 * A flow dependency bundle for one session.
 *
 * @param git - a git client.
 * @param sessionId - the session id to act as.
 * @param extra - dependency overrides for the case.
 * @returns the dependency bundle.
 */
function depsFor(git, sessionId = "session-a", extra = {}) {
  return {
    git,
    files: nodeFileAccess,
    sessionId,
    pid: process.pid,
    registry: registryOf(),
    config: CONFIG,
    ...extra,
  };
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
      "session-dead": claim("session-dead", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/abandoned",
        integration: "main",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
        pid: 1073741824, // above any real pid: certainly not running
      }),
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
      "session-dead": claim("session-dead", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/deleted-already",
        integration: "main",
        baseCommit: head,
        pid: 1073741824,
      }),
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
    // company (so this session is isolated), never as abandoned work. It counts
    // because it is *resident*, which is the answer a pid could not give: this
    // process's pid is alive whether or not that session still exists.
    await git.text(["branch", "feature/in-progress"]);
    await writeLedger(git, {
      "session-live": claim("session-live", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/in-progress",
        integration: "main",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
      }),
    });

    const result = await startFlow(depsFor(git, "session-a", { registry: registryOf("session-live") }), "add login");
    assert.equal(result.kind, "started");
    assert.equal(result.parallelSessions, 1, "a live session counts as company");
    assert.deepEqual(result.outstandingBranches, [], "and never as abandoned work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("keeps one ledger for the whole clone, worktrees included", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The trap this pins. `--git-common-dir` gave "the same file from anywhere" for
    // free; a directory in the working tree does not, and a ledger resolved from the
    // session's own directory would give every linked worktree its own copy. The copy
    // a worktree session reads is exactly the one that cannot tell it another session
    // is already working here — so concurrency detection would fail silently, in the
    // one case that needs it.
    const worktree = join(root, ROOT, "nested");
    await git.text(["worktree", "add", "-q", "-b", "feature/nested", worktree]);
    const fromWorktree = git.withCwd(worktree);

    const record = (sessionId) =>
      claim(sessionId, {
        repoKey: `${root}/.git`,
        repoRoot: root,
        branch: `feature/${sessionId}`,
        integration: "main",
        baseCommit: "0".repeat(40),
      });

    await writeLedger(fromWorktree, { "session-in-worktree": record("session-in-worktree") });
    const readFromMain = await readLedger(git);
    assert.ok(readFromMain["session-in-worktree"], "the main tree must see what the worktree wrote");

    await writeLedger(git, { "session-in-main": record("session-in-main") });
    const readFromWorktree = await readLedger(fromWorktree);
    assert.ok(readFromWorktree["session-in-main"], "and the worktree must see what the main tree wrote");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a start that creates no worktree still keeps its state out of git", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A lone session works in place, so no worktree is created — and yet this command
    // still leaves a ledger in the working tree, holding absolute paths belonging to
    // this machine. This plugin adds no ignore rule for it (that is the ruling), so a
    // careless `git add --all` really would stage it; what the plugin guarantees is
    // that *its own* commands never do. Both halves are asserted, because the second
    // is the reason the first is survivable.
    const result = await startFlow(depsFor(git), "add login");
    assert.equal(result.kind, "started");
    assert.equal(result.worktreePath, null, "a lone session works in place");
    assert.ok((await readLedger(git))["session-a"], "the ledger really was written");

    assert.equal(
      await git.ok(["check-ignore", "-q", "--no-index", join(root, ".dsh.local", "git-flow.json")]),
      false,
      "no ignore rule is added for the local state, by design",
    );
    assert.equal(
      await exists(join(root, ".gitignore")),
      false,
      "and no .gitignore is created to hold one",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("isolates a session instead of adopting a branch a stranger owns", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The ordinary way to hit this: two top-level sessions, one working directory.
    // The first opens a branch there, so the second no longer sees the integration
    // branch — it sees the first session's branch. Adopting it would put two
    // sessions' work on one branch, and refusing would send the human back to
    // /git-start, which is what adopted it in the first place.
    await git.text(["switch", "-c", "feature/theirs"]);
    await writeLedger(git, {
      "session-other": claim("session-other", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/theirs",
        integration: "main",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
      }),
    });

    const result = await startFlow(
      depsFor(git, "session-B", { registry: registryOf("session-other") }),
      "add the login redirect",
    );
    assert.equal(result.kind, "started", "it must not adopt a stranger's branch");
    assert.equal(result.branch, "feature/login-redirect", "it gets a branch of its own");
    assert.ok(result.worktreePath !== null, "isolated in a worktree, which is the point");
    assert.equal(await currentBranch(git), "feature/theirs", "and the stranger's checkout is untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a delegate asking for a branch of its own is isolated too", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A subagent normally shares its parent's branch and never gets a worktree. When
    // it names one explicitly it asked for its own — and switching the shared
    // checkout would silently repoint its parent's work at a different branch.
    const result = await startFlow(
      depsFor(git, "session-parent", { isDelegate: true }),
      undefined,
      "subagent-side-quest",
    );
    assert.equal(result.kind, "started");
    assert.ok(result.worktreePath !== null, "the shared checkout must not be repointed");
    assert.equal(await currentBranch(git), "main", "so the main tree stays where it was");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("keeps a lone delegate in place when it asks for nothing of its own", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The default for a family: one checkout, one branch, no worktree per subagent.
    await git.text(["switch", "-c", "feature/parents-branch"]);
    const result = await startFlow(depsFor(git, "session-parent", { isDelegate: true }), "add login");
    assert.equal(result.kind, "already-on-feature", "a delegate adopts its parent's branch");
    assert.equal(result.branch, "feature/parents-branch");
    assert.equal(result.worktreePath, null, "and is not handed a checkout of its own");
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
    // Another live session in the same repository: same process, different session
    // id — so the pid cannot separate them and residency is what makes it count.
    await writeLedger(git, {
      "session-other": claim("session-other", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/other",
        integration: "main",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
      }),
    });

    const started = await startFlow(
      depsFor(git, "session-a", { registry: registryOf("session-other") }),
      "isolate this work",
    );
    assert.equal(started.kind, "started");
    assert.equal(started.parallelSessions, 1);
    assert.ok(started.worktreePath !== null, "a session that arrives second must be isolated");
    // The worktree is a linked repository, so a careless `git add --all` in the main
    // tree stages it as a gitlink pointing at a commit that disappears with the
    // worktree. No ignore rule prevents that here (the ruling), so the guarantee is
    // narrower and worth asserting precisely: the plugin's own staging never does it,
    // because its commands exclude the local directory by pathspec.
    await git.text(["add", "--all"]);
    const careless = await git.text(["ls-files", "-s"]);
    assert.ok(
      careless.includes("160000"),
      `without an ignore rule a careless add does stage the worktree, which is the accepted risk: ${careless}`,
    );
    await git.text(["reset", "-q"]);
    await git.text(["add", "--all", "--", ".", ":!.dsh.local"]);
    const own = await git.text(["ls-files", "-s"]);
    assert.ok(!own.includes("160000"), `but the plugin's own add must not, got: ${own}`);
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
    // The rule is pre-seeded and committed, so starting changes nothing in the tree.
    // That matters: a first start legitimately adds the rule as a tracked change, and
    // this case is about a branch that never received any *work* — not about the
    // unrelated commit, whose own content would make the branch non-empty and mask it.
    await writeFile(join(root, "unrelated.txt"), "not the feature\n", "utf8");
    await git.text(["add", "--all"]);
    await git.text(["commit", "-q", "-m", "chore: something unrelated"]);

    const started = await startFlow(depsFor(git), "add login");
    assert.equal(started.kind, "started");
    assert.equal(started.worktreePath, null, "a lone session works in place");

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

await verify("cleanup removes a worktree nothing is using and keeps the branch", async () => {
  const { root, git } = await scratchRepo();
  try {
    // What a session that was closed mid-feature leaves: a claim, a worktree and a
    // branch. The branch has commits the integration branch does not have, so it is
    // reported and never deleted — that is work, and nothing else records whose it was.
    const worktree = join(root, ROOT, "abandoned");
    await git.text(["worktree", "add", "-q", "-b", "feature/abandoned", worktree]);
    await writeFile(join(worktree, "file.txt"), "unfinished\n", "utf8");
    await git.withCwd(worktree).text(["commit", "-qam", "feat: half a feature"]);
    await writeLedger(git, {
      "session-gone": claim("session-gone", {
        repoKey: await commonDir(git),
        repoRoot: root,
        tree: "own",
        worktreePath: worktree,
        branch: "feature/abandoned",
        integration: "main",
        pid: 1073741824,
      }),
    });

    const result = await cleanupFlow({ git, config: CONFIG, registry: registryOf(), pid: process.pid });
    assert.deepEqual(result.removedWorktrees, [worktree], "a clean worktree nobody owns is removed");
    assert.deepEqual(result.unmergedBranches, ["feature/abandoned"], "and its branch is reported, not deleted");
    assert.deepEqual(result.forgottenClaims, ["feature/abandoned"], "the claim is dropped, naming what it left");
    assert.equal(await exists(worktree), false);
    assert.ok((await git.text(["branch", "--list", "feature/abandoned"])).includes("feature/abandoned"));
    assert.equal((await readLedger(git))["session-gone"], undefined, "and the ledger no longer holds the claim");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("cleanup leaves a dirty worktree and a live session alone", async () => {
  const { root, git } = await scratchRepo();
  try {
    const dirty = join(root, ROOT, "dirty");
    await git.text(["worktree", "add", "-q", "-b", "feature/dirty", dirty]);
    await writeFile(join(dirty, "file.txt"), "not committed\n", "utf8");

    const live = join(root, ROOT, "live");
    await git.text(["worktree", "add", "-q", "-b", "feature/live", live]);
    await writeLedger(git, {
      "session-dirty": claim("session-dirty", {
        repoKey: await commonDir(git),
        repoRoot: root,
        tree: "own",
        worktreePath: dirty,
        branch: "feature/dirty",
        pid: 1073741824,
      }),
      "session-live": claim("session-live", {
        repoKey: await commonDir(git),
        repoRoot: root,
        tree: "own",
        worktreePath: live,
        branch: "feature/live",
      }),
    });

    const result = await cleanupFlow({
      git,
      config: CONFIG,
      registry: registryOf("session-live"),
      pid: process.pid,
    });
    assert.deepEqual(result.removedWorktrees, [], "nothing is removed");
    assert.equal(result.keptWorktrees.length, 1, "the dirty one is kept");
    assert.equal(result.keptWorktrees[0].path, dirty, "and it is the dirty one");
    assert.ok(result.keptWorktrees[0].reason.includes("uncommitted"), `got: ${result.keptWorktrees[0].reason}`);
    assert.equal(await exists(dirty), true, "uncommitted work is never removed");
    assert.equal(await exists(live), true, "and neither is a live session's worktree");
    assert.equal(result.liveClaims, 1, "whose claim is left in force");
    assert.equal((await readLedger(git))["session-live"] !== undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
