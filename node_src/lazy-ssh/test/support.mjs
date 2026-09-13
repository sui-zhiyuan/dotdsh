/**
 * The scaffolding every committed check shares.
 *
 * Two stand-ins let `pnpm test` drive the whole lazy-session protocol on a
 * machine with no ssh server, no network and no harness:
 *
 * - a **fake transport** — a plain object with `run`, `release` and
 *   `detachRelease` — for the lifetime checks, where the point is *when* the
 *   pool acts, not what ssh does. Its promises are resolvable by hand, so
 *   "while a call is in flight" is a fact the check creates rather than a race
 *   it hopes for.
 * - a **fake `ssh`** — a real `sh` script written into a scratch directory and
 *   handed to the real {@link nodeRunner} as `config.sshBinary` — for the wire
 *   checks, where the point is exactly which argv this package handed to a
 *   process. It appends one line per invocation to a log file; a marker file
 *   named after the `ControlPath` stands in for OpenSSH's control socket so the
 *   log can say whether an invocation would have become a master or joined one.
 *
 * The fake ssh is not OpenSSH and the fake transport is not ssh at all: what
 * each one *does* prove is stated in the header of the check that uses it.
 *
 * Each `verify-*.mjs` file imports from this module, runs its own checks, and
 * ends with {@link report}.
 *
 * @module @dsh-external/dotdsh-lazy-ssh/test/support
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshPool } from "../lib/core/pool.js";
import { nodeRunner } from "../lib/platform/exec.js";
import { ensureControlDir, SshTransport } from "../lib/platform/ssh.js";

let passed = 0;
const failures = [];

/**
 * Run one named check.
 *
 * A thrown assertion is a failed check, not a crashed suite: the remaining
 * checks still run, so one broken path does not hide the state of the others.
 *
 * @param name - what this check proves, in one line.
 * @param body - the check; async and sync both work.
 */
export async function check(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`ok   ${name}`);
  } catch (error) {
    const detail = error instanceof Error ? (error.message ?? String(error)) : String(error);
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL ${name}\n     ${detail}`);
  }
}

/** Print the tally and exit non-zero when anything failed. */
export function report() {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  ${failure}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

/**
 * Wait, using a timer that keeps the process alive.
 *
 * The pool unrefs its own idle timers, so a check that only awaited a pool
 * deadline could let Node exit first. Every wait here is an ordinary referenced
 * timer, which is what holds the event loop open for the duration of a check.
 *
 * @param ms - milliseconds to wait.
 */
export function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until a predicate holds, or fail the check.
 *
 * @param predicate - returns true once the waited-for state is observable.
 * @param options - `timeoutMs`, `intervalMs`, and a `label` for the failure text.
 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 10, label = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`waited ${timeoutMs} ms for ${label} and it never happened`);
    }
    await wait(intervalMs);
  }
}

/** A promise the check resolves or rejects itself. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * One scratch directory, removed by the caller.
 *
 * @param prefix - the mkdtemp prefix, so a leftover directory names its check.
 * @returns the directory and its cleanup.
 */
export async function scratchDir(prefix = "lazy-ssh-check-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A finished process result with everything at its quiet default. */
export function runResult(overrides = {}) {
  return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...overrides };
}

/**
 * The ssh transport contract, standing in for {@link SshTransport}.
 *
 * `run` is whatever the check passes as `handlers.run`; the default answers
 * immediately. `release` and `detachRelease` record synchronously, which is what
 * lets a check observe a timer's decision without awaiting the release.
 *
 * @param handlers - `{ run }`, called as `run(destination, command, options, index)`.
 * @returns the transport-shaped object plus the three call records.
 */
export function fakeTransport(handlers = {}) {
  const calls = [];
  const released = [];
  const detached = [];
  const run = handlers.run ?? (() => Promise.resolve(runResult()));
  const transport = {
    run(destination, command, options) {
      const index = calls.length;
      calls.push({ destination, command, options });
      return run(destination, command, options, index);
    },
    release(destination) {
      released.push(destination);
      return Promise.resolve();
    },
    detachRelease(destination) {
      detached.push(destination);
    },
  };
  return { transport, calls, released, detached };
}

/**
 * A pool over a fake transport, with the idle window the check wants.
 *
 * @param overrides - pool options; `idleTimeoutMs` is the one checks vary most.
 * @returns the pool and the fake transport's records.
 */
export function fakePool(overrides = {}) {
  const { run, ...poolOptions } = overrides;
  const fake = fakeTransport(run === undefined ? {} : { run });
  const pool = new SshPool(fake.transport, {
    idleTimeoutMs: 60_000,
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1 << 20,
    ...poolOptions,
  });
  return { pool, ...fake };
}

/** The base `SshConfig` a wire check varies one field of. */
export function baseConfig(overrides = {}) {
  return {
    sshBinary: "ssh",
    controlDir: "/nonexistent-control-dir",
    connectTimeoutSec: 10,
    idleTimeoutMs: 300_000,
    batchMode: true,
    sshOptions: [],
    ...overrides,
  };
}

/**
 * The control path this package documents for one destination.
 *
 * Recomputed here from the module's stated derivation — a digest of the
 * destination and the extra options, under `controlDir` — so the exact
 * `ControlPath=` element can be pinned rather than merely pattern-matched. The
 * doc-level properties (one path per destination-and-options, shared by the
 * command and the release) are asserted separately.
 *
 * @param config - the row's ssh configuration.
 * @param destination - the ssh destination.
 */
export function controlPathFor(config, destination) {
  const digest = createHash("sha256")
    .update(destination)
    .update("\0")
    .update(config.sshOptions.join("\0"))
    .digest("hex")
    .slice(0, 16);
  return join(config.controlDir, `${digest}.sock`);
}

/** The `sh` script that stands in for `ssh`. See the module header for its contract. */
const FAKE_SSH = `#!/bin/sh
# A fake ssh for the committed checks. It logs every invocation and answers
# -O exit by removing the marker file that stands in for the control socket.
set -u

LOG="\${FAKE_SSH_LOG:?FAKE_SSH_LOG must name the log file this fake ssh appends to}"

control=""
mode=""
previous=""
last=""
for argument in "$@"; do
  case "$argument" in
    ControlPath=*) control="\${argument#ControlPath=}" ;;
  esac
  if [ "$previous" = "-O" ]; then mode="$argument"; fi
  previous="$argument"
  last="$argument"
done

record() {
  record_kind="$1"
  record_detail="$2"
  shift 2
  record_argv=$(printf '\\t%s' "$@")
  printf '%s\\t%s\\t%s%s\\n' "$record_kind" "$control" "$record_detail" "$record_argv" >> "$LOG"
}

if [ "$mode" = "exit" ]; then
  if [ -e "$control" ]; then
    record REL present "$@"
    rm -f "$control"
    exit 0
  fi
  record REL absent "$@"
  printf 'Control socket connect(%s): No such file or directory\\n' "$control" >&2
  exit 255
fi

if [ -e "$control" ]; then
  record CMD join "$@"
else
  : > "$control"
  record CMD master "$@"
fi

case "$last" in
  block*)
    # A command that outlives its deadline, emulated without a child process so
    # the SIGTERM that ends it is observable at once.
    printf 'partial-output\\n'
    while :; do :; done
    ;;
  *)
    exec sh -c "$last"
    ;;
esac
`;

/**
 * A real `sh` script standing in for `ssh`, with the log it will write.
 *
 * @param dir - the scratch directory that holds both files.
 * @returns the executable path, the log path, and the control directory it
 *   expects the caller to have created.
 */
export async function fakeSsh(dir) {
  const binary = join(dir, "fake-ssh");
  const logPath = join(dir, "ssh.log");
  await writeFile(binary, FAKE_SSH, "utf8");
  await chmod(binary, 0o755);
  return { binary, logPath, controlDir: join(dir, "control") };
}

/**
 * Read the fake ssh's log, one record per invocation.
 *
 * A line is `kind \t controlPath \t detail \t arg1 \t arg2 …`, where `argv` is
 * what the process saw after the executable. Empty when nothing has run yet.
 *
 * @param logPath - the fake ssh's log file.
 * @returns one record per invocation, in the order they happened.
 */
export function readEvents(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [kind, control, detail, ...argv] = line.split("\t");
      return { kind, control, detail, argv };
    });
}

/**
 * The real seam, wired to the fake ssh: a scratch directory, the script, the
 * control directory it needs, and a transport over the real {@link nodeRunner}.
 *
 * The log path travels to the child through this process's environment, because
 * `SshTransport` deliberately passes no environment of its own.
 *
 * @param overrides - `SshConfig` fields this check varies.
 * @returns everything the check needs, including a cleanup for the directory.
 */
export async function realSeam(overrides = {}) {
  const scratch = await scratchDir();
  const fake = await fakeSsh(scratch.dir);
  process.env.FAKE_SSH_LOG = fake.logPath;
  ensureControlDir(fake.controlDir);
  const config = baseConfig({ sshBinary: fake.binary, controlDir: fake.controlDir, ...overrides });
  const transport = new SshTransport(nodeRunner, config);
  return { ...scratch, ...fake, config, transport };
}

/** A pool over the real seam, with a lifetime the check chooses. */
export function seamPool(seam, overrides = {}) {
  return new SshPool(seam.transport, {
    idleTimeoutMs: 60_000,
    commandTimeoutMs: 5_000,
    maxOutputBytes: 1 << 20,
    ...overrides,
  });
}

/** Re-exported so the wire checks do not have to reach into `node:assert` twice. */
export { assert };
