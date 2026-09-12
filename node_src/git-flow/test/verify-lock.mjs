// The committed check for the claim lock. Run: pnpm test
//
// The lock is the one mechanism every claim depends on, and every way it can be
// wrong is silent: a critical section that lets two holders in loses a claim and
// nothing reports it; a release that deletes someone else's file lets a third
// claimant in behind the second's back; a stale lock that is never broken wedges
// every session in the repository.
//
// Every case drives the BUILT lib/ against real files in a temporary directory.
// Built-ins and the real `git` binary only: no harness, no profile, no network.
//
// What a green run does NOT mean: exclusion on a network mount. `O_EXCL` is
// emulated client-side by older NFS and the pid describes another machine's
// process space, so on a shared mount only the age test recovers a dead holder —
// and no test here can stand in for that. It also does not prove fairness: the
// timeouts are what keep two contenders from starving, not the lock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gitClient, nodeRunner } from "../lib/exec.js";
import { isAbandoned, lockPath, withLock, LockTimeoutError } from "../lib/lock.js";

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
 * A scratch repository to hold the lock file.
 *
 * @returns the repository path and a git client bound to it.
 */
async function scratchRepo() {
  const root = await mkdtemp(join(tmpdir(), "dsh-git-flow-lock-"));
  const git = gitClient(nodeRunner, root);
  await git.text(["-c", "init.defaultBranch=main", "init", "-q"]);
  return { root, git };
}

/** The built lib/ directory, so a child process can drive the same code. */
const LIB = new URL("../lib/", import.meta.url);

/**
 * Write a lock file directly, as a crashed or foreign holder would have left it.
 *
 * @param path - the lock file.
 * @param holder - what to put in it.
 */
async function seedLock(path, holder) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(holder));
}

/** A holder of a fresh, live lock — this test process itself. */
function liveHolder(token, at = new Date().toISOString()) {
  return { token, pid: process.pid, at };
}

await verify("a second holder waits rather than entering", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The same-process case, which is the ordinary one: two sessions of one dsh
    // process claiming at nearly the same moment. If the section were not mutually
    // exclusive the two entries would interleave.
    const events = [];
    const section = (name) => async () => {
      events.push(`enter ${name}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`exit ${name}`);
    };
    await Promise.all([withLock(git, section("a")), withLock(git, section("b"))]);
    assert.deepEqual(
      events.filter((event) => event.startsWith("enter")).length,
      2,
      "both sections must run",
    );
    assert.ok(
      events[0].startsWith("enter") && events[1].startsWith("exit") && events[2].startsWith("enter"),
      `the sections must not interleave, got: ${events.join(", ")}`,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("two processes exclude each other", async () => {
  const { root, git } = await scratchRepo();
  try {
    // The other dsh process in the same repository. The child runs the same code
    // against the same lock file, so this is the mechanism rather than the module
    // graph being trusted: `O_EXCL` is enforced by the kernel.
    const log = join(root, "order.log");
    const child = `
import { appendFile } from "node:fs/promises";
import { gitClient, nodeRunner } from ${JSON.stringify(new URL("exec.js", LIB).href)};
import { withLock } from ${JSON.stringify(new URL("lock.js", LIB).href)};
const git = gitClient(nodeRunner, ${JSON.stringify(root)});
await withLock(git, async () => {
  await appendFile(${JSON.stringify(log)}, "enter\\n");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await appendFile(${JSON.stringify(log)}, "exit\\n");
});
`;
    const run = () =>
      new Promise((resolve, reject) => {
        const proc = spawn(process.execPath, ["--input-type=module", "-e", child], { stdio: "inherit" });
        proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${String(code)}`))));
      });
    await Promise.all([run(), run()]);

    const lines = (await readFile(log, "utf8")).trim().split("\n");
    assert.deepEqual(lines, ["enter", "exit", "enter", "exit"], "the sections must be serialized across processes");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a lock whose process is gone is broken instead of wedging the repository", async () => {
  const { root, git } = await scratchRepo();
  try {
    const path = await lockPath(git);
    await seedLock(path, { token: "dead", pid: 1073741824, at: new Date().toISOString() });
    let ran = false;
    await withLock(git, async () => {
      ran = true;
    });
    assert.equal(ran, true, "the section must run once the dead holder is out of the way");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("releasing a lock that is no longer ours leaves the new holder's file alone", async () => {
  const { root, git } = await scratchRepo();
  try {
    // What breaking a stale lock looks like from the broken holder's side: it is
    // still inside its section and has no idea it lost the lock. A bare `unlink`
    // here would delete the successor's file and let a third claimant in.
    const path = await lockPath(git);
    await withLock(git, async () => {
      await seedLock(path, liveHolder("someone-else"));
    });
    const survivor = JSON.parse(await readFile(path, "utf8"));
    assert.equal(survivor.token, "someone-else", "the successor's lock must survive the broken holder's release");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

await verify("a live, fresh holder is never treated as abandoned", async () => {
  // The rule that keeps the same-process case safe: two sessions share a pid, so a
  // holder that is merely slow must not be broken. Only a dead pid breaks it.
  assert.equal(isAbandoned(liveHolder("a"), Date.now()), false);
  assert.equal(isAbandoned({ token: "a", pid: 1073741824, at: new Date().toISOString() }, Date.now()), true);
  assert.equal(isAbandoned(liveHolder("a", new Date(Date.now() - 120_000).toISOString()), Date.now()), true);
  assert.equal(
    isAbandoned({ token: "", pid: 0, at: "" }, Date.now()),
    true,
    "a crash between creating the file and writing it leaves no holder at all",
  );
});

await verify("gives up with a reason instead of hanging forever", async () => {
  const { root, git } = await scratchRepo();
  try {
    const path = await lockPath(git);
    // A fresh lock held by a live process: never broken, so the waiter must fail
    // loudly rather than wait for a holder that may never release.
    await seedLock(path, liveHolder("held"));
    const started = Date.now();
    await assert.rejects(
      withLock(git, async () => undefined, { timeoutMs: 50 }),
      (error) => error instanceof LockTimeoutError,
    );
    assert.ok(Date.now() - started < 5_000, "and give up on its own timeout, not on a default one");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`);
for (const { name, error } of failures) console.log(`\n${name}\n${error.stack ?? error.message}`);
process.exitCode = failures.length === 0 ? 0 : 1;
