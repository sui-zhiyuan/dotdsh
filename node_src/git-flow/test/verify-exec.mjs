/**
 * The committed check for the process seam. Run: pnpm test
 *
 * Every other module in this plugin is written against `GitClient`, so a fault in
 * the seam under it is not one broken feature but all of them at once — and the
 * two halves of the seam fail in opposite silences. A runner that let a shell see
 * its argv would turn a model-written commit message into a command; a client that
 * threw where it should return an exit code would turn `ok`'s ordinary "no" into a
 * crash. Neither shows up in a test of the feature above it, so both are pinned
 * here, against the BUILT `lib/platform/exec.js`.
 *
 * The client's own half of the seam is checked the only way it can be from here:
 * by constructing a client over a *capturing* runner, so what the client hands
 * down — argv, cwd, the forced git environment, a caller's signal — is observed at
 * the boundary rather than inferred from git's behaviour.
 *
 * What a green run does NOT mean: that the harness's `ctx.subprocess` behaves like
 * `nodeRunner`. This file pins `nodeRunner`, the plain `node:child_process` spawn
 * the committed tests run on; production goes through the harness runner, whose
 * argv-exactness is the harness's contract to keep, not this file's.
 */
import assert from "node:assert/strict";
import { tmpdir } from "node:os";

import { GitClient, GitError, nodeRunner } from "../lib/platform/exec.js";
import { check, report, scratchRepo, signal } from "./support.mjs";

await check("nodeRunner hands a child its argument verbatim, with no shell in between", async () => {
  // A branch name, a path and a commit message all reach git as arguments, and the
  // message is model-written. If this runner composed a command line instead of an
  // argv, the `$`, the backticks and the quotes below would be interpreted before
  // git ever saw them — so the child reports the argument it actually received.
  const argument = `a b $HOME $(id) \`whoami\` "double" 'single' ; echo pwned`;
  const result = await nodeRunner(
    [process.execPath, "-e", "process.stdout.write(process.argv[1])", argument],
    { cwd: tmpdir() },
  );
  assert.equal(result.code, 0);
  assert.equal(result.stdout, argument);
  assert.equal(result.stderr, "");
});

await check("a non-zero exit is returned as code, not thrown as an error", async () => {
  // `GitClient.ok` is built entirely on this: "is this ref an ancestor" is answered
  // by an exit code, and a runner that rejected on one would turn every ordinary no
  // into an exception.
  const result = await nodeRunner(
    [process.execPath, "-e", "process.stderr.write('nope\\n'); process.exit(7)"],
    { cwd: tmpdir() },
  );
  assert.equal(result.code, 7);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "nope\n");
});

await check("code -1 stands for a child that died by signal", async () => {
  // A signal death has no exit code at all — `close` reports null — and the module
  // flattens that to -1 so every caller sees the same numeric shape. The child
  // kills itself, which is the one way to make that deterministic.
  const result = await nodeRunner(
    [process.execPath, "-e", "process.kill(process.pid, 'SIGKILL')"],
    { cwd: tmpdir() },
  );
  assert.equal(result.code, -1);
});

await check("GitClient.text trims stdout, and GitClient.run does not", async () => {
  const repo = await scratchRepo();
  try {
    // Both entry points are asserted because the comparison is the contract:
    // trimming belongs to `text`, while `run` stays the raw escape hatch.
    const raw = await repo.git.run(["rev-parse", "--abbrev-ref", "HEAD"]);
    assert.equal(raw.code, 0);
    assert.equal(raw.stdout, "master\n");
    assert.equal(await repo.git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master");
  } finally {
    await repo.cleanup();
  }
});

await check("GitClient.ok is the exit-code predicate, in both directions", async () => {
  const repo = await scratchRepo();
  try {
    assert.equal(await repo.git.ok(["rev-parse", "--verify", "HEAD"]), true);
    assert.equal(await repo.git.ok(["rev-parse", "--verify", "refs/heads/nope"]), false);
  } finally {
    await repo.cleanup();
  }
});

await check("GitClient.text throws GitError carrying args, code and trimmed stderr", async () => {
  const repo = await scratchRepo();
  try {
    const args = ["rev-parse", "--verify", "refs/heads/does-not-exist"];
    const raw = await repo.git.run(args);
    assert.notEqual(raw.code, 0);
    assert.ok(raw.stderr.trim().length > 0, "the failed call is expected to diagnose itself on stderr");

    let caught;
    try {
      await repo.git.text(args);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof Error, "text must throw, not resolve with undefined");
    assert.ok(caught instanceof GitError);
    assert.equal(caught.name, "GitError");
    assert.deepEqual(caught.args, args);
    assert.equal(caught.code, raw.code);
    assert.equal(caught.stderr, raw.stderr.trim());
    // The message is what a human ends up reading after a refusal quotes it, so both
    // the command that failed and git's own words have to be in it.
    assert.match(caught.message, /^git rev-parse --verify refs\/heads\/does-not-exist failed \(exit \d+\): /);
    assert.ok(caught.message.includes(`exit ${String(raw.code)}`), caught.message);
    assert.ok(caught.message.includes(raw.stderr.trim()), caught.message);
  } finally {
    await repo.cleanup();
  }
});

await check("GitClient forces argv[0], cwd and the git environment onto every invocation", async () => {
  const repo = await scratchRepo();
  try {
    // A capturing runner records exactly what the client handed it and then
    // delegates to `nodeRunner`, so the calls below are still live git — and the
    // env is read at the boundary instead of guessed from git's behaviour.
    const calls = [];
    const capturing = (argv, options) => {
      calls.push({ argv, options });
      return nodeRunner(argv, options);
    };
    const git = new GitClient(capturing, repo.root);
    await git.run(["rev-parse", "--show-toplevel"]);
    await git.text(["--version"]);

    assert.equal(calls.length, 2, "both calls should go through the runner");
    assert.equal(git.cwd, repo.root);
    for (const { argv, options } of calls) {
      assert.equal(argv[0], "git");
      assert.equal(options.cwd, git.cwd);
      // Forced on every call, whatever the command: LC_ALL keeps git's messages
      // quotable, and the two GIT_* switches keep the child off a terminal and off
      // the index lock.
      assert.equal(options.env.GIT_TERMINAL_PROMPT, "0");
      assert.equal(options.env.GIT_OPTIONAL_LOCKS, "0");
      assert.equal(options.env.LC_ALL, "C");
    }
    assert.deepEqual(calls[0].argv, ["git", "rev-parse", "--show-toplevel"]);
    assert.deepEqual(calls[1].argv, ["git", "--version"]);
  } finally {
    await repo.cleanup();
  }
});

await check("a per-call signal reaches the runner, and a call without one sends none", async () => {
  // `text` and `run` both funnel into one `run`, so proving the spread here proves
  // it for every call shape. The absent half matters too: `spawn` treats an
  // explicit `undefined` signal differently from a missing one.
  const seen = [];
  const stub = (argv, options) => {
    seen.push({ argv, options });
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
  const git = new GitClient(stub, tmpdir());
  await git.text(["status"], { signal });
  await git.run(["status"]);

  assert.equal(seen.length, 2);
  assert.equal(seen[0].options.signal, signal);
  assert.ok(!("signal" in seen[1].options), "an unsignalled call must not carry a signal key");
});

report();
