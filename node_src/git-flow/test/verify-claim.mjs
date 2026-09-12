// The committed check for the claim path. Run: pnpm test
//
// This file exists because of one failure, and the first case is that failure: two
// sessions in one repository, **neither of which opened a branch through the flow**.
// The ledger used to learn that a session existed only when it opened a branch, so a
// session standing on a branch it did not open was invisible — it was missing from
// the list that decides both whether a starting session is isolated and whether a
// write belongs to someone else, and two families ended up writing the same files on
// the same branch.
//
// Every case drives the BUILT lib/ against a real repository in a temporary
// directory. Built-ins and the real `git` binary only: no harness, no profile, no
// network.
//
// What a green run does NOT mean: that the harness delivers `tools/pre-execute`, or
// that a real dsh process picks its cwd the way these cases do. The seam itself is
// settled by a live session; what is settled here is the decision the plugin makes
// once it is called.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimLatch, ensureClaim } from "../lib/claim.js";
import { gitClient, nodeRunner } from "../lib/exec.js";
import { decideToolCall } from "../lib/guard.js";
import { commonDir, currentBranch, readLedger, writeLedger } from "../lib/repo.js";
import { GitFlowState } from "../lib/state.js";

const CONFIG = {
  branchPrefix: "feature/",
  integrationBranch: undefined,
  worktreeRoot: ".dsh.local/worktrees",
  useWorktreeWhenBusy: true,
  commitUncommittedBeforeMerge: true,
  mergeMessage: "Merge {branch} into {integration}",
  guard: "auto-start",
  guardBash: false,
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
 * Create a scratch repository with one commit on `master`.
 *
 * @returns the repository path and a git client bound to it.
 */
async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-flow-claim-"));
  const git = gitClient(nodeRunner, root);
  await git.text(["-c", "init.defaultBranch=master", "init", "-q"]);
  await git.text(["config", "user.email", "test@example.invalid"]);
  await git.text(["config", "user.name", "dsh git-flow test"]);
  await writeFile(join(root, "file.txt"), "one\n", "utf8");
  await git.text(["add", "--all"]);
  await git.text(["commit", "-q", "-m", "init"]);
  return { root, git };
}

/** A session registry stub in which the listed ids are resident. */
function resident(...ids) {
  return { get: (id) => (ids.includes(id) ? { header: {} } : undefined) };
}

/** A claim record for seeding the ledger. */
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

/** The claim dependencies for one family in one repository. */
function depsFor(git, sessionId, extra = {}) {
  return {
    git,
    sessionId,
    pid: process.pid,
    registry: resident(),
    config: CONFIG,
    latch: new ClaimLatch(),
    ...extra,
  };
}

/** A pending call as the seam presents it. */
function callFor({ sessionId = "session-a", cwd, prompt = "Add the login redirect" }) {
  return {
    callId: "call-1",
    rootCallId: "call-1",
    name: "write",
    arguments: { file_path: join(cwd, "notes.txt"), content: "x\n" },
    agent: {
      session: {
        id: sessionId,
        header: { cwd },
        deriveMessages: () => [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: prompt }] }],
      },
    },
    signal: new AbortController().signal,
    token: {},
  };
}

/** The runtime the guard reads, for one dsh process. */
function runtimeFor(latch = new ClaimLatch(), sessions = resident()) {
  return {
    runner: nodeRunner,
    state: new GitFlowState(),
    config: CONFIG,
    pid: process.pid,
    latch,
    sessions,
  };
}

/** The continuation: what a call reaching the rest of the pipeline decides. */
const allow = async () => ({ kind: "allow" });

await verify("two sessions that opened no branch cannot both write in the main tree", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The reported failure. Session A writes first and takes the main tree; session B
    // stands in the same checkout, on the branch A has just opened. Before the claim,
    // B's write was allowed with no record and no check, and both sessions wrote the
    // same files on the same branch.
    const process = runtimeFor(new ClaimLatch(), resident("session-a", "session-b"));
    const first = await decideToolCall(process, callFor({ sessionId: "session-a", cwd: root }), allow);
    assert.deepEqual(first, { kind: "allow" }, "the first writer opens a branch in place and proceeds");

    const claims = await readLedger(git);
    assert.equal(claims["session-a"].tree, "main", "the first writer owns the main tree");
    assert.equal(claims["session-a"].branch, "feature/login-redirect", "and its branch is recorded");

    const second = await decideToolCall(process, callFor({ sessionId: "session-b", cwd: root }), allow);
    assert.equal(second.kind, "deny", "the second session must not be allowed to write here");
    assert.ok(
      second.reason.includes("same checkout"),
      `the refusal must name the collision, got: ${second.reason}`,
    );
    assert.equal(
      (await readLedger(git))["session-b"].tree,
      "own",
      "and the second session is visible in the ledger, assigned a tree of its own",
    );
    assert.equal(await currentBranch(git), "feature/login-redirect", "no second branch is opened in that tree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("the first claim takes the main tree and the next one does not", async () => {
  const { root, git } = await scratchRepo();
  try {
    // Both sessions live in one dsh process, which is the ordinary case: they are
    // resident, and a pid cannot tell them apart.
    const latch = new ClaimLatch();
    const sessions = resident("session-a", "session-b");
    const first = await ensureClaim(depsFor(git, "session-a", { latch, registry: sessions }));
    assert.deepEqual(first, { kind: "claimed", changed: true });
    assert.equal((await readLedger(git))["session-a"].tree, "main");

    const second = await ensureClaim(depsFor(git, "session-b", { latch, registry: sessions }));
    assert.equal(second.kind, "claimed");
    const claims = await readLedger(git);
    assert.equal(claims["session-b"].tree, "own", "the main tree is taken, so this family gets one of its own");
    assert.equal(claims["session-b"].worktreePath, null, "which does not exist until the flow creates it");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a claim names no branch, because a branch is the flow's business", async () => {
  const { root, git } = await scratchRepo();
  try {
    // Recording whatever is checked out would make `/git-complete` offer to merge a
    // stranger's branch: a session can be standing on one it did not open.
    await git.text(["switch", "-c", "feature/someone-elses"]);
    await ensureClaim(depsFor(git, "session-a"));
    const claims = await readLedger(git);
    assert.equal(claims["session-a"].branch, null, "the claim says nothing about the branch it is standing on");
    assert.equal(claims["session-a"].tree, "main");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a claim whose session is gone does not hold the tree", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The phantom neighbour: a session of *this* process that has closed keeps a pid
    // that is very much alive, so a pid test would hold the main tree for it forever
    // and hand every later session a worktree it did not need.
    await writeLedger(git, {
      "session-closed": claim("session-closed", { repoKey: await commonDir(git), repoRoot: root }),
    });
    await ensureClaim(depsFor(git, "session-b"));
    assert.equal((await readLedger(git))["session-b"].tree, "main", "the tree its closed owner left is free");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a family already in a worktree claims that worktree", async () => {
  const { root, git } = await scratchRepo();
  try {
    const worktree = join(root, ".dsh.local/worktrees/login");
    await git.text(["worktree", "add", "-q", "-b", "feature/login", worktree]);
    await ensureClaim(depsFor(git.withCwd(worktree), "session-a"));
    const own = (await readLedger(git))["session-a"];
    assert.equal(own.tree, "own");
    assert.equal(own.worktreePath, worktree, "and points at the tree it is actually in");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a warm latch claims once and writes nothing after that", async () => {
  const { root, git } = await scratchRepo();
  try {
    const latch = new ClaimLatch();
    await ensureClaim(depsFor(git, "session-a", { latch }));
    const ledger = join(root, ".dsh.local/git-flow.json");
    const before = await readFile(ledger, "utf8");
    const again = await ensureClaim(depsFor(git, "session-a", { latch }));
    assert.deepEqual(again, { kind: "claimed", changed: false }, "the second call is answered from the latch");
    assert.equal(await readFile(ledger, "utf8"), before, "and the ledger is not even read, let alone written");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("losing the latch is a cache miss, not a lost claim", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The rule the latch is built on: nothing may be correct only because it is warm.
    await ensureClaim(depsFor(git, "session-a"));
    const cold = await ensureClaim(depsFor(git, "session-a", { latch: new ClaimLatch() }));
    assert.equal(cold.kind, "claimed", "a fresh process claims again rather than refusing");
    assert.deepEqual(cold, { kind: "claimed", changed: false }, "and finds the assignment already made");
    const claims = await readLedger(git);
    assert.equal(claims["session-a"].tree, "main", "which is preserved, not re-decided");
    assert.equal(Object.keys(claims).length, 1, "and the ledger still holds exactly one claim");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("the latch is per repository, not per process", async () => {
  const first = await scratchRepo();
  const second = await scratchRepo();
  try {
    // One dsh process can hold sessions in several repositories, so a latch keyed by
    // the family alone would leave the second repository unclaimed and invisible.
    const latch = new ClaimLatch();
    await ensureClaim(depsFor(first.git, "session-a", { latch }));
    await ensureClaim(depsFor(second.git, "session-a", { latch }));
    assert.equal((await readLedger(first.git))["session-a"].tree, "main");
    assert.equal((await readLedger(second.git))["session-a"].tree, "main", "the second repository is claimed too");
  } finally {
    await rm(first.root, { recursive: true, force: true });
    await rm(second.root, { recursive: true, force: true });
  }
});

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`);
for (const { name, error } of failures) console.log(`\n${name}\n${error.stack ?? error.message}`);
process.exitCode = failures.length === 0 ? 0 : 1;
