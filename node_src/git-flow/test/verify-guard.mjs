// The committed check for the pre-write branch guard. Run: pnpm test
//
// The guard is the plugin's only enforcement point — everything else is prompt
// text the model may or may not follow — and it had no committed check until a
// manual probe on the integration branch produced the branch `feature/github`
// from a Chinese prompt that merely mentioned GitHub. That is the kind of defect
// a test catches and a one-off try does not.
//
// It is testable without a harness because the decision is a plain function of a
// runtime, a pending call and the waterfall continuation: `decideToolCall` takes
// the same shape here as it does at the `tools/pre-execute` seam, `nodeRunner`
// stands in for `ctx.subprocess`, and the scratch repository is real. What is
// faked is only the agent: a session id, a cwd, and the messages the intent
// extractor reads.
//
// What a green run does NOT mean: there is no harness here, so nothing proves
// that dsh invokes the listener, that an `Error: <reason>` really reaches the
// model, or that `exec.signal` cancels a gate mid-flight. What is proven is the
// decision itself — allow, deny, and the branch a decision leaves behind.
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimLatch } from "../lib/claim.js";
import { gitClient, nodeRunner } from "../lib/exec.js";
import { decideToolCall } from "../lib/guard.js";
import { commonDir, currentBranch, writeLedger } from "../lib/repo.js";
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
 * `master` rather than `main` on purpose: it exercises the fallback order in
 * `defaultIntegrationBranch`, which is what most local repositories hit.
 *
 * @returns the repository path and a git client bound to it.
 */
async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-flow-guard-"));
  const git = gitClient(nodeRunner, root);
  await git.text(["-c", "init.defaultBranch=master", "init", "-q"]);
  await git.text(["config", "user.email", "test@example.invalid"]);
  await git.text(["config", "user.name", "dsh git-flow test"]);
  await writeFile(join(root, "file.txt"), "one\n", "utf8");
  await git.text(["add", "--all"]);
  await git.text(["commit", "-q", "-m", "init"]);
  return { root, git };
}

/**
 * A pending call as the seam presents it.
 *
 * @param options - overrides for name, arguments, cwd, session id and prompt.
 * @returns a `ToolExecution`-shaped object the guard reads.
 */
function callFor({
  name = "write",
  args = { file_path: "notes.txt", content: "x\n" },
  cwd,
  sessionId = "session-a",
  prompt = "Add the login redirect",
  header = {},
}) {
  return {
    callId: "call-1",
    rootCallId: "call-1",
    name,
    arguments: args,
    agent: {
      session: {
        id: sessionId,
        header: { cwd, ...header },
        deriveMessages: () => [{ role: "user", source: { kind: "user" }, content: [{ type: "text", text: prompt }] }],
      },
    },
    signal: new AbortController().signal,
    token: {},
  };
}

/**
 * The runtime the guard reads, with the standalone runner and a fresh cache.
 *
 * The latch is per runtime, because a runtime is what one dsh process has: a case
 * that wants to watch the claim path run twice has to pass its own.
 *
 * @param config - the resolved settings for the case.
 * @param namer - the model-backed namer, when the case has one.
 * @param sessions - the registry slice.
 * @param latch - the claim latch, defaulting to a fresh one.
 * @returns the runtime.
 */
function runtimeFor(config = CONFIG, namer, sessions = { get: () => undefined }, latch = new ClaimLatch()) {
  return {
    runner: nodeRunner,
    state: new GitFlowState(),
    config,
    pid: process.pid,
    latch,
    sessions,
    ...(namer === undefined ? {} : { namerFor: () => namer }),
  };
}

/**
 * Tell whether a path exists.
 *
 * @param path - the path to test.
 * @returns whether it exists.
 */
async function exists(path) {
  return access(path).then(
    () => true,
    () => false,
  );
}

/** A registry that answers with the given headers, so a chain can be walked. */
function registry(headers) {
  return { get: (id) => (id in headers ? { header: headers[id] } : undefined) };
}

/**
 * The registry a case needs for a peer to count as live.
 *
 * Liveness is not a pid question: this process's pid is alive whether or not one
 * of its sessions still exists, so a same-process peer is live because it is
 * **resident**, and a case that seeds one has to say so.
 *
 * @param ids - session ids present in this process.
 * @returns the registry slice.
 */
function resident(...ids) {
  return registry(Object.fromEntries(ids.map((id) => [id, {}])));
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

/** The continuation: what a call reaching the rest of the pipeline decides. */
const allow = async () => ({ kind: "allow" });

/** Register another live session in this repository, so the guard sees company. */
async function addLiveSession(git, root, branch = "feature/other") {
  await writeLedger(git, {
    "session-other": claim("session-other", {
      repoKey: await commonDir(git),
      repoRoot: root,
      branch,
      integration: "master",
      baseCommit: await git.text(["rev-parse", "HEAD"]),
    }),
  });
}

await verify("lets a subagent write in its parent's checkout", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A subagent runs in its parent's working directory, so the parent's branch is
    // the branch it is working on — the same workflow, not a second one. Judged by
    // the immediate session id it looked like a stranger occupying the checkout, and
    // every write a subagent made was refused.
    await git.text(["switch", "-c", "feature/parent"]);
    await writeLedger(git, {
      "session-parent": claim("session-parent", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/parent",
        integration: "master",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
      }),
    });

    const sessions = registry({ "session-child": { cwd: root, parentSession: "session-parent", origin: "subagent", delegationDepth: 1 }, "session-parent": { cwd: root } });
    const subagent = callFor({
      cwd: root,
      sessionId: "session-child",
      header: { parentSession: "session-parent", origin: "subagent", delegationDepth: 1 },
    });
    const decision = await decideToolCall(runtimeFor(CONFIG, undefined, sessions), subagent, allow);
    assert.deepEqual(decision, { kind: "allow" }, `a subagent is family, not a competitor: ${JSON.stringify(decision)}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("still refuses a sibling in the same checkout", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The control for the case above: a session with no parent is a competitor, and
    // writing here would land on the other session's branch.
    await git.text(["switch", "-c", "feature/parent"]);
    await writeLedger(git, {
      "session-parent": claim("session-parent", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/parent",
        integration: "master",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
      }),
    });

    const sibling = callFor({ cwd: root, sessionId: "session-sibling" });
    const decision = await decideToolCall(runtimeFor(CONFIG, undefined, resident("session-parent")), sibling, allow);
    assert.equal(decision.kind, "deny");
    assert.ok(decision.reason.includes("same checkout"), `got: ${decision.reason}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log("pre-write guard");

await verify("opens a feature branch instead of letting a write land on master", async () => {
  const { root, git } = await scratchRepo();
  try {
    const decision = await decideToolCall(runtimeFor(), callFor({ cwd: root }), allow);
    assert.deepEqual(decision, { kind: "allow" }, "the write must proceed once the branch exists");
    assert.equal(await currentBranch(git), "feature/login-redirect", "the branch must be named from the intent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("refuses to name a branch after an incidental Latin word in a Chinese prompt", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The regression: this is the real opening prompt that produced `feature/github`.
    const prompt =
      "我需要创建一个插件（或者其他什么东西？） ， 实现如下功能， 你先搜索 github 上是否有完美实现， 如果有，告诉我";
    const decision = await decideToolCall(runtimeFor(), callFor({ cwd: root, prompt }), allow);
    assert.equal(decision.kind, "deny", "an unnameable intent must refuse rather than guess");
    assert.ok(
      decision.reason.includes("/git-start"),
      `the refusal must say how to proceed, got: ${decision.reason}`,
    );
    assert.equal(await currentBranch(git), "master", "and must leave the repository on master");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("names a Chinese prompt through the model rather than refusing the write", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The requirement's main path, end to end through the guard: the session said
    // what it is doing, just not in a Latin script, so the model names it and the
    // write proceeds. This is the case the earlier version got wrong by asking.
    const namer = async () => ({ kind: "named", candidate: "git-flow-plugin" });
    const prompt = "我需要创建一个插件（或者其他什么东西？） ， 实现如下功能， 你先搜索 github 上是否有完美实现";
    const decision = await decideToolCall(runtimeFor(CONFIG, namer), callFor({ cwd: root, prompt }), allow);
    assert.deepEqual(decision, { kind: "allow" }, "the write must proceed once a name was found");
    assert.equal(await currentBranch(git), "feature/git-flow-plugin", "named by the model, not after `github`");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("leaves a call alone when the session is not on the integration branch", async () => {
  const { root, git } = await scratchRepo();
  try {
    await git.text(["switch", "-c", "feature/already-open"]);
    const decision = await decideToolCall(runtimeFor(), callFor({ cwd: root }), allow);
    assert.deepEqual(decision, { kind: "allow" });
    assert.equal(await currentBranch(git), "feature/already-open", "no second branch may be created");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("isolates a session that arrives while another is live, and redirects its first write", async () => {
  const { root, git } = await scratchRepo();
  try {
    await addLiveSession(git, root);
    const decision = await decideToolCall(
      runtimeFor(CONFIG, undefined, resident("session-other")),
      callFor({ cwd: root }),
      allow,
    );

    // The arriving session gets its own checkout — that is the isolation the
    // requirement asks for — and the write that triggered the start is sent to the
    // same file inside it, because allowing it would defeat the isolation on its
    // first use.
    assert.equal(decision.kind, "deny", "the triggering write must move into the new worktree");
    assert.ok(
      decision.reason.includes(".dsh.local/worktrees/"),
      `the refusal must name the worktree, got: ${decision.reason}`,
    );
    assert.ok(
      decision.reason.includes("notes.txt"),
      `the refusal must name the file to write instead, got: ${decision.reason}`,
    );
    // The branch exists as a ref, but the worktree holds it: the main tree is
    // deliberately left where it was, because another session is using it.
    const branches = await git.text(["branch", "--list", "feature/login-redirect"]);
    assert.ok(branches.includes("feature/login-redirect"), "the branch must exist");
    assert.equal(await currentBranch(git), "master", "and the main tree must stay on the integration branch");
    const tree = await git.text(["worktree", "list", "--porcelain"]);
    assert.ok(tree.includes(".dsh.local/worktrees/"), "and the worktree it points at must exist");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("refuses when another live session is in this very checkout", async () => {
  const { root, git } = await scratchRepo();
  try {
    // Two sessions with one working directory: the first opened `feature/shared`
    // there, so the second no longer sees the integration branch checked out and
    // would quietly write onto the first session's branch. This is the shape the
    // guard has to catch, and it is not the same question as "are others live".
    await git.text(["switch", "-c", "feature/shared"]);
    await writeLedger(git, {
      "session-other": claim("session-other", {
        repoKey: await commonDir(git),
        repoRoot: root,
        branch: "feature/shared",
        integration: "master",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
      }),
    });

    const decision = await decideToolCall(
      runtimeFor(CONFIG, undefined, resident("session-other")),
      callFor({ cwd: root }),
      allow,
    );
    assert.equal(decision.kind, "deny");
    assert.ok(
      decision.reason.includes("same checkout"),
      `the refusal must name the collision, got: ${decision.reason}`,
    );
    assert.equal(await currentBranch(git), "feature/shared", "and must not open a second branch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a stale record does not block a free tree", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The other session's process is alive but its branch is not what is checked
    // out here — the human switched back, or it finished without /git-complete.
    // A record is a claim about the past; the tree's actual branch decides.
    await addLiveSession(git, root, "feature/other");
    const decision = await decideToolCall(
      runtimeFor(CONFIG, undefined, resident("session-other")),
      callFor({ cwd: root }),
      allow,
    );
    assert.equal(decision.kind, "deny", "isolation still applies while another session is live");
    assert.ok(
      decision.reason.includes(".dsh.local/worktrees/"),
      `but as a redirect into a worktree, not a same-checkout refusal, got: ${decision.reason}`,
    );
    // A free main tree is claimed by opening a branch and isolating this session in
    // a worktree — not by refusing, which is what an earlier version did and what
    // made a merely idle session block the repository for everyone.
    const branches = await git.text(["branch", "--list", "feature/login-redirect"]);
    assert.ok(branches.includes("feature/login-redirect"), "the branch must be opened");
    assert.equal(await currentBranch(git), "master", "while the main tree stays where it was");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("ignores tools that do not write files, and touches nothing", async () => {
  const { root, git } = await scratchRepo();
  try {
    // A read is not guarded, not claimed, and not observed: the model is not told where
    // it stands, so there is nothing for a read-only call to keep fresh. What a read
    // must never do is leave a trace in the repository.
    const read = await decideToolCall(
      runtimeFor(),
      callFor({ cwd: root, name: "read", args: { file_path: "file.txt" } }),
      allow,
    );
    assert.deepEqual(read, { kind: "allow" });
    assert.equal(await exists(join(root, ".dsh.local")), false, "a read claims nothing and writes nothing");
    // `str_replace_editor view` is a read wearing a mutating tool's name: a guard
    // that blocked it would be worse than no guard.
    const view = await decideToolCall(
      runtimeFor(),
      callFor({ cwd: root, name: "str_replace_editor", args: { command: "view", path: join(root, "file.txt") } }),
      allow,
    );
    assert.deepEqual(view, { kind: "allow" });
    assert.equal(await currentBranch(git), "master", "neither call may open a branch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("ignores a write that targets nothing inside the repository", async () => {
  const { root, git } = await scratchRepo();
  const outside = await mkdtemp(join(tmpdir(), "dsh-git-flow-outside-"));
  try {
    const decision = await decideToolCall(
      runtimeFor(),
      callFor({ cwd: root, args: { file_path: join(outside, "elsewhere.txt"), content: "x\n" } }),
      allow,
    );
    assert.deepEqual(decision, { kind: "allow" });
    assert.equal(await currentBranch(git), "master", "a write outside the repository is not this plugin's business");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

await verify("keeps an isolated session inside its worktree", async () => {
  const { root, git } = await scratchRepo();
  try {
    const worktree = join(root, ".dsh.local/worktrees/login");
    await git.text(["worktree", "add", "-q", "-b", "feature/login", worktree]);
    await writeLedger(git, {
      "session-a": claim("session-a", {
        repoKey: await commonDir(git),
        repoRoot: root,
        tree: "own",
        branch: "feature/login",
        worktreePath: worktree,
        integration: "master",
        baseCommit: await git.text(["rev-parse", "HEAD"]),
      }),
    });

    const stray = await decideToolCall(
      runtimeFor(),
      callFor({ cwd: root, args: { file_path: join(root, "file.txt"), content: "x\n" } }),
      allow,
    );
    assert.equal(stray.kind, "deny", "editing the main tree would collide with whoever is in it");
    assert.ok(stray.reason.includes(worktree), `the refusal must name the worktree, got: ${stray.reason}`);
    assert.ok(
      stray.reason.includes(join(worktree, "file.txt")),
      `the refusal must say where to write instead, got: ${stray.reason}`,
    );

    const inside = await decideToolCall(
      runtimeFor(),
      callFor({ cwd: root, args: { file_path: join(worktree, "file.txt"), content: "x\n" } }),
      allow,
    );
    assert.deepEqual(inside, { kind: "allow" }, "a write inside the worktree is exactly what the isolation wants");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("denies without acting when the guard is set to block", async () => {
  const { root, git } = await scratchRepo();
  try {
    const decision = await decideToolCall(runtimeFor({ ...CONFIG, guard: "block" }), callFor({ cwd: root }), allow);
    assert.equal(decision.kind, "deny");
    assert.ok(decision.reason.includes("/git-start"), `the refusal must point at the command, got: ${decision.reason}`);
    assert.equal(await currentBranch(git), "master", "blocking mode must not open a branch itself");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("does nothing at all when the guard is off", async () => {
  const { root, git } = await scratchRepo();
  try {
    const decision = await decideToolCall(runtimeFor({ ...CONFIG, guard: "off" }), callFor({ cwd: root }), allow);
    assert.deepEqual(decision, { kind: "allow" });
    assert.equal(await currentBranch(git), "master");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("leaves the Bash tool alone unless it is opted in", async () => {
  const { root, git } = await scratchRepo();
  try {
    const bash = { command: "echo hi > file.txt" };
    const untouched = await decideToolCall(runtimeFor(), callFor({ cwd: root, name: "bash", args: bash }), allow);
    assert.deepEqual(untouched, { kind: "allow" });
    assert.equal(await currentBranch(git), "master", "the default must not open a branch for a shell command");

    const guarded = await decideToolCall(
      runtimeFor({ ...CONFIG, guardBash: true }),
      callFor({ cwd: root, name: "bash", args: bash }),
      allow,
    );
    assert.deepEqual(guarded, { kind: "allow" });
    assert.equal(await currentBranch(git), "feature/login-redirect", "with guardBash on, the branch is opened first");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("passes a call through in a directory that is not a repository", async () => {
  const plain = await mkdtemp(join(tmpdir(), "dsh-git-flow-plain-"));
  try {
    const decision = await decideToolCall(runtimeFor(), callFor({ cwd: plain }), allow);
    assert.deepEqual(decision, { kind: "allow" });
  } finally {
    await rm(plain, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
