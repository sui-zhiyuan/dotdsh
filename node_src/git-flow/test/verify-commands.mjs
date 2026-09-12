// The committed check for the two slash commands' contract with the web UI.
//
// Nothing type-checks across this boundary. The client dispatches by command
// name, renders `description` in the menu, and decides between *completing* a
// command and *executing* it from the presence of `input` alone — a host command
// that declares `input` becomes a claim (the composer inserts `/git-start ` and
// waits for the argument), while one that does not is executed the moment it is
// picked. Rename a command or drop that field and everything still builds, still
// loads, and still "works": it simply runs before the human can type a name,
// which is exactly the bug this file now pins.
//
// The text these commands print is checked here too. It is the only route from a
// failed attempt to a fix — it names the branch, the tree to write in, the command
// to run — and it has no compiler either.
//
// What a green run does NOT mean: nothing here renders a menu or presses a key.
// The client's decision table is read from its source, not exercised; what is
// proven is that this plugin supplies the fields that table reads.
import assert from "node:assert/strict";
import { registerCommands, reportComplete, reportStart } from "../lib/commands.js";
import { nodeRunner } from "../lib/exec.js";
import { GitFlowState } from "../lib/state.js";

let passed = 0;
const failures = [];

/**
 * Run one named case, reporting rather than throwing so every case is attempted.
 *
 * @param {string} name - what the case proves.
 * @param {() => Promise<void> | void} body - the case, which asserts for itself.
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

/** Register both commands against a fake registry and return what was registered. */
function capture() {
  const definitions = [];
  const ctx = {
    commands: {
      register(definition) {
        definitions.push(definition);
        return () => {};
      },
    },
  };
  const runtime = { runner: nodeRunner, state: new GitFlowState(), config: CONFIG, pid: process.pid };
  registerCommands(ctx, runtime);
  return definitions;
}

/** A `/git-start` outcome with everything absent unless overridden. */
function started(overrides = {}) {
  return {
    kind: "started",
    branch: "feature/login-redirect",
    integration: "main",
    worktreePath: null,
    baseCommit: "0".repeat(40),
    ignoreChanged: false,
    gitignorePath: undefined,
    gitignorePattern: undefined,
    parallelSessions: 0,
    trackedGitlink: false,
    outstandingBranches: [],
    ...overrides,
  };
}

console.log("slash commands");

await verify("registers exactly the names the client dispatches", () => {
  const names = capture()
    .map((definition) => definition.name)
    .sort();
  assert.deepEqual(names, ["git-cleanup", "git-complete", "git-start"]);
});

await verify("every command carries a description for the menu", () => {
  for (const definition of capture()) {
    assert.equal(typeof definition.description, "string");
    assert.ok(definition.description.length > 0, `${definition.name} needs a description`);
  }
});

await verify("git-start declares an argument, so picking it completes instead of running", () => {
  const definition = capture().find((entry) => entry.name === "git-start");
  assert.ok(definition.input !== undefined, "without `input` the client executes the command on the pick");
  assert.equal(typeof definition.input.hint, "string");
  assert.ok(definition.input.hint.length > 0, "the hint is the placeholder the composer shows");
  assert.ok(/branch/i.test(definition.input.hint), `the hint must say what to type, got ${definition.input.hint}`);
});

await verify("git-cleanup and git-complete stay bare, so one pick still runs them", () => {
  for (const name of ["git-cleanup", "git-complete"]) {
    const definition = capture().find((entry) => entry.name === name);
    assert.equal(
      definition.input,
      undefined,
      `${name}: declaring input would force a second Enter on a command that takes no argument`,
    );
  }
});

await verify("a start reports where to work and what it changed underneath", () => {
  const plain = reportStart(started());
  assert.equal(plain.kind, "success");
  assert.ok(plain.text.includes("feature/login-redirect"), "the branch it opened must be named");

  const isolated = reportStart(
    started({ worktreePath: "/repo/.dsh.local/worktrees/login-redirect", parallelSessions: 1 }),
  );
  assert.ok(isolated.text.includes("/repo/.dsh.local/worktrees/login-redirect"), "the worktree must be named");
  assert.ok(/absolute paths/i.test(isolated.text), "and the human must be told to use them");

  // The report must not promise a `.gitignore` rule: this plugin adds none, and the
  // local state is kept out of its own commits by excluding it from its own commands.
  // Nor does it warn about a staged gitlink any more — with no rule and no check,
  // there is nothing to observe, and the plugin's own commands never stage one.
  assert.ok(!plain.text.includes(".gitignore"), "no ignore rule is claimed, because none is added");
  assert.ok(!/git rm --cached/.test(plain.text), "and no staged-gitlink warning is invented");

  const leftover = reportStart(started({ outstandingBranches: ["feature/abandoned"] }));
  assert.ok(leftover.text.includes("feature/abandoned"), "unmerged work left by a dead session must be surfaced");
});

await verify("a start that could not name the feature asks for a name", () => {
  const reported = reportStart({
    kind: "need-name",
    integration: "main",
    parallelSessions: 0,
    reason: "the naming rules could not slug this session's prompt (no model route is available)",
  });
  assert.equal(reported.kind, "success", "nothing went wrong: the workflow is waiting on the human");
  assert.ok(reported.text.includes("/git-start <name>"), "and must say exactly how to answer");
  assert.ok(reported.text.includes("no model route"), "while keeping the reason it could not decide");
});

await verify("a completed feature reports the replay and what was cleaned up", () => {
  const reported = reportComplete({
    kind: "merged",
    branch: "feature/login-redirect",
    integration: "main",
    mergeCommit: "abcdef1234567890",
    rebased: true,
    rebasedFrom: "1234567890abcdef",
    collectedCommit: "fedcba0987654321",
    removedWorktree: "/repo/.dsh.local/worktrees/login-redirect",
    deletedBranch: true,
    warnings: ["the tree at /repo had uncommitted changes"],
  });
  assert.equal(reported.kind, "success");
  assert.ok(reported.text.includes("abcdef12"), "the merge commit must be shown");
  assert.ok(/replayed/.test(reported.text), "a replay must be stated, not hidden");
  assert.ok(reported.text.includes("fedcba09"), "collected work must be accounted for");
  assert.ok(reported.text.includes("/repo/.dsh.local/worktrees/login-redirect"), "the removed worktree must be named");
  assert.ok(reported.text.includes("warning:"), "warnings must survive to the human");
});

await verify("a conflict reports the step it happened in and the command that resolves it", () => {
  const rebase = reportComplete({
    kind: "conflicted",
    branch: "feature/login",
    integration: "main",
    during: "rebase",
    files: ["src/a.ts"],
  });
  assert.equal(rebase.kind, "error");
  assert.ok(rebase.text.includes("src/a.ts"), "the conflicted file must be named");
  assert.ok(/git rebase --onto/.test(rebase.text), "a replay conflict needs the replay command");
  assert.ok(/force-pushed/.test(rebase.text), "and the promise that nothing was forced");

  const merge = reportComplete({
    kind: "conflicted",
    branch: "feature/login",
    integration: "main",
    during: "merge",
    files: ["src/a.ts"],
  });
  assert.ok(/merge --no-ff/.test(merge.text), "a merge conflict needs the merge command, not the replay one");
});

await verify("a branch with nothing to merge is reported as such, not as success", () => {
  const reported = reportComplete({
    kind: "no-changes",
    branch: "feature/empty",
    integration: "main",
    reason: "'feature/empty' has no commits that 'main' does not already contain",
  });
  assert.equal(reported.kind, "success", "a false start is not a failure");
  assert.ok(/still there/.test(reported.text), "and the branch must be left, not silently deleted");
  assert.ok(reported.text.includes("git branch -D"), "with the way to remove it if it was a false start");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
