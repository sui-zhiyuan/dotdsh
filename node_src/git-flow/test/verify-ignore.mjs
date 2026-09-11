// The committed check for the ignore guard. Run: pnpm test
//
// This is the plugin's single most consequential piece of code, and the one
// whose failure is silent. If it is wrong, nothing errors: the repository simply
// gains a gitlink entry on some later `git add --all`, pointing at a commit that
// disappears when the worktree does. So this file does not test that a line was
// appended — it tests the property that actually matters, by running the same
// `git add --all` a careless session would run and asserting that the worktree
// directory is not in the index.
//
// The guard is given the local-state directory (`<repo>/.dsh.local`), not one
// entry inside it: one rule then covers every session's worktree and the ledger,
// future, and the entry does not change as branches come and go.
//
// Every case builds a real repository under a temporary directory and drives the
// BUILT lib/ (the `test` script builds first). Built-ins and the real `git`
// binary only: no harness, no profile, no network.
//
// What a green run does NOT mean: there is no harness here, so nothing proves
// that `ctx.fs` accepts the policy this plugin resolves, that a session's cwd is
// what the ledger expects, or that a worktree created by `git worktree add`
// under one git version behaves as it does under another. The guard's own
// behaviour — write before create, verify after write, refuse when verification
// fails — is what is proven.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitClient, nodeRunner } from "../lib/exec.js";
import { nodeFileAccess } from "../lib/file-access.js";
import { ensureIgnored, ignoreComment } from "../lib/ignore.js";

const WORKTREE_ROOT = ".dsh.local";
const FEATURE_DIR = `${WORKTREE_ROOT}/add-login`;

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
  const root = await mkdtemp(join(tmpdir(), "dsh-git-flow-ignore-"));
  const git = gitClient(nodeRunner, root);
  await git.text(["-c", "init.defaultBranch=main", "init", "-q"]);
  await git.text(["config", "user.email", "test@example.invalid"]);
  await git.text(["config", "user.name", "dsh git-flow test"]);
  await writeFile(join(root, "README.md"), "scratch\n", "utf8");
  await git.text(["add", "--all"]);
  await git.text(["commit", "-q", "-m", "init"]);
  return { root, git };
}

/** Paths staged in the index, with their mode, as `<mode> <path>` lines. */
async function stagedEntries(git) {
  return (await git.text(["ls-files", "-s"])).split("\n").filter((line) => line !== "");
}

/** The guard call under test, aimed at the worktree root. */
function guard(root, git) {
  return { git, files: nodeFileAccess, comment: ignoreComment(), directory: join(root, WORKTREE_ROOT) };
}

console.log("ignore guard");

await verify("creates the entry before the directory exists, and git agrees", async () => {
  const { root, git } = await scratchRepo();
  try {
    // Deliberately NOT created: the guard must protect a directory that does not
    // exist yet, because it runs before `git worktree add`. This is also the
    // case where `git check-ignore` has to answer about a path with no
    // filesystem entry behind it.
    const result = await ensureIgnored(guard(root, git));

    assert.equal(result.needed, true, "a directory inside the repository needs a rule");
    assert.equal(result.changed, true, "the first run must write the entry");
    assert.equal(result.pattern, `${WORKTREE_ROOT}/`);

    const written = await readFile(join(root, ".gitignore"), "utf8");
    assert.ok(written.includes("# dsh git-flow:"), "the comment explaining the rule must be written");
    assert.ok(written.includes(`${WORKTREE_ROOT}/`), "the pattern must be written");
    assert.ok(
      written.indexOf("# dsh git-flow:") < written.indexOf(`${WORKTREE_ROOT}/`),
      "the comment must sit above the pattern it explains",
    );
    assert.ok(result.rule?.includes(WORKTREE_ROOT), `check-ignore must confirm the rule, got ${result.rule}`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a real nested worktree is NOT staged by `git add --all`", async () => {
  const { root, git } = await scratchRepo();
  try {
    await ensureIgnored(guard(root, git));
    await git.text(["worktree", "add", "-q", "-b", "feature/add-login", join(root, FEATURE_DIR)]);

    const staged = await stagedEntries(git);
    const modes = staged.map((line) => line.split(/\s+/)[0]);
    assert.ok(!modes.includes("160000"), `no embedded-repository gitlink may be staged, got: ${staged.join(" | ")}`);
    assert.ok(
      !staged.some((line) => line.includes(WORKTREE_ROOT)),
      `nothing under ${WORKTREE_ROOT} may be staged, got: ${staged.join(" | ")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("the failure it prevents is real: without the guard the gitlink IS staged", async () => {
  const { root, git } = await scratchRepo();
  try {
    // No guard call at all — the state this plugin must never allow. If this
    // case ever stops failing, git's behaviour changed and the guard's whole
    // premise needs re-deriving.
    await git.text(["worktree", "add", "-q", "-b", "feature/add-login", join(root, FEATURE_DIR)]);
    await git.text(["add", "--all"]);
    const staged = await stagedEntries(git);
    assert.ok(
      staged.some((line) => line.startsWith("160000") && line.includes(WORKTREE_ROOT)),
      "this test is only meaningful while git really does stage a gitlink here",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("is idempotent: a second run changes nothing", async () => {
  const { root, git } = await scratchRepo();
  try {
    await ensureIgnored(guard(root, git));
    const first = await readFile(join(root, ".gitignore"), "utf8");
    const second = await ensureIgnored(guard(root, git));
    assert.equal(second.changed, false, "the second run must not rewrite the file");
    assert.equal(await readFile(join(root, ".gitignore"), "utf8"), first, "the file must be untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a broader existing rule is respected instead of duplicated", async () => {
  const { root, git } = await scratchRepo();
  try {
    // `.dsh.*` is broader than the exact pattern and genuinely covers `.dsh.local/`,
    // which is what this case is about: a rule that already does the job must not be
    // duplicated. (`.dsh/` would not cover it — the two names are unrelated.)
    await writeFile(join(root, ".gitignore"), ".dsh.*\n", "utf8");
    const result = await ensureIgnored(guard(root, git));
    assert.equal(result.changed, false, "a covering rule needs no new entry");
    assert.equal(await readFile(join(root, ".gitignore"), "utf8"), ".dsh.*\n", "the file must be untouched");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a file with no final newline keeps its last line intact", async () => {
  const { root, git } = await scratchRepo();
  try {
    await writeFile(join(root, ".gitignore"), "node_modules", "utf8");
    await ensureIgnored(guard(root, git));
    const lines = (await readFile(join(root, ".gitignore"), "utf8")).split("\n");
    assert.equal(lines[0], "node_modules", "the existing rule must not be glued to the new comment");
    assert.ok(
      lines.some((line) => line.trim() === `${WORKTREE_ROOT}/`),
      "the new pattern must be readable as its own line",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("CRLF files stay CRLF", async () => {
  const { root, git } = await scratchRepo();
  try {
    await writeFile(join(root, ".gitignore"), "node_modules\r\nbuild\r\n", "utf8");
    await ensureIgnored(guard(root, git));
    const written = await readFile(join(root, ".gitignore"), "utf8");
    assert.ok(written.endsWith("\r\n"), "an appended line must use the file's own line ending");
    assert.ok(!/[^\r]\n/.test(written), "no bare LF may be introduced into a CRLF file");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("refuses when a negation rule defeats an entry that is already present", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The reachable defeat: the pattern is already listed — so the guard has
    // nothing left to write — and a later `!` line unstages it again. A guard
    // that only checked "is my line in the file?" would report success here and
    // leave the worktree exposed.
    await writeFile(join(root, ".gitignore"), `${WORKTREE_ROOT}/\n!${WORKTREE_ROOT}/\n`, "utf8");
    await assert.rejects(
      ensureIgnored(guard(root, git)),
      /still does not ignore/,
      "an unverifiable entry must fail loudly rather than leave an exposed worktree",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("reports an already-staged gitlink that a human must remove", async () => {
  const { root, git } = await scratchRepo();
  try {
    await git.text(["worktree", "add", "-q", "-b", "feature/add-login", join(root, FEATURE_DIR)]);
    await git.text(["add", "--all"]);
    await git.text(["commit", "-q", "-m", "oops: embedded repository"]);
    const result = await ensureIgnored(guard(root, git));
    assert.equal(
      result.trackedGitlink,
      true,
      "an index entry that already records the worktree must be reported, not hidden",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a directory outside the repository needs no rule", async () => {
  const { root, git } = await scratchRepo();
  const outside = await mkdtemp(join(tmpdir(), "dsh-git-flow-outside-"));
  try {
    const result = await ensureIgnored({
      git,
      files: nodeFileAccess,
      comment: ignoreComment(),
      directory: join(outside, "somewhere"),
    });
    assert.equal(result.needed, false);
    assert.equal(result.changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
