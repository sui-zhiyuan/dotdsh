/**
 * The committed check for the lazy-session pool and the wire it speaks.
 * Run: pnpm test
 *
 * The package's whole subject is a lifetime: one OpenSSH master per server, kept
 * until the server has been idle for `idleTimeoutMs`, reused by every call that
 * arrives before then. That lifetime is invisible to a running dsh — a wrong
 * release costs a handshake nobody sees and a missed release leaves a socket
 * behind — so it is pinned here, against the BUILT `lib/`.
 *
 * Two harnesses, for two different questions:
 *
 * - a fake transport whose promises the check resolves by hand, because "while a
 *   call is in flight" must be a fact the check creates, not a race it hopes to
 *   win. That is what rule 1 (the entry exists before the first `await`), rule 2
 *   (only the last user drops a failed entry) and rule 3 (dispose does not wait)
 *   are checked with.
 * - the real `nodeRunner` and a real `sh` script standing in for `ssh`, because
 *   the exact argv handed to a process is the package's contract with OpenSSH.
 *   The script logs every invocation, and a marker file named after the
 *   `ControlPath` stands in for the control socket.
 *
 * What a green run does NOT prove: that OpenSSH multiplexes, that a real ssh
 * honours `ControlMaster`/`ControlPath`/`ControlPersist`, that `~/.ssh`
 * authenticates anything, that the control socket is really a credential, that
 * the control directory is on a filesystem a real ssh would accept, or that
 * `nodeRunner` behaves like the harness's own subprocess service. The fake ssh
 * decides "master" and "join" from a marker file, and it reproduces a mux
 * client's held-open pipes with a subshell that inherits its streams; both are
 * this check's stand-in for OpenSSH's behaviour, not a measurement of it. The
 * deadline checks therefore prove that a runner resolving on `close` cannot
 * settle at its deadline, not that a real master holds pipes the way this
 * stand-in does. Nor does it prove the idle timer is exact to the millisecond —
 * timers are only ever asserted to fall inside a window wide enough to survive a
 * loaded machine.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { SshPool } from "../lib/core/pool.js";
import { Config, resolveSshConfig } from "../lib/index.js";
import { nodeRunner } from "../lib/platform/exec.js";
import {
  CONTROL_PERSIST_GRACE_SEC,
  SshTransport,
  commandArgv,
  ensureControlDir,
  releaseArgv,
  validateDestination,
} from "../lib/platform/ssh.js";
import {
  assert,
  baseConfig,
  check,
  controlPathFor,
  deferred,
  fakePool,
  processAlive,
  readEvents,
  realSeam,
  report,
  runResult,
  scratchDir,
  seamPool,
  wait,
  waitFor,
} from "./support.mjs";

/**
 * The idle-timeout slack OpenSSH's own backstop gets, as `ssh.ts` documents it.
 *
 * Spelled as a literal rather than read from `CONTROL_PERSIST_GRACE_SEC`: a check
 * whose expected value moves with the constant it is checking cannot fail when
 * that constant changes. The exported constant is asserted against this literal
 * in its own check below.
 */
const DOCUMENTED_CONTROL_PERSIST_GRACE_SEC = 30;

/** The fixed option block every command call opens with, as `ssh.ts` documents it. */
function expectedOptionBlock(config, destination) {
  const block = [
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPathFor(config, destination)}`,
    "-o",
    `ControlPersist=${Math.max(1, Math.ceil(config.idleTimeoutMs / 1000) + DOCUMENTED_CONTROL_PERSIST_GRACE_SEC)}`,
    "-o",
    `ConnectTimeout=${config.connectTimeoutSec}`,
  ];
  // BatchMode is the one member of the block the config can drop, and it sits
  // after ConnectTimeout and before the caller's own options.
  if (config.batchMode) block.push("-o", "BatchMode=yes");
  return block;
}

await check("the documented config defaults resolve, and a value that cannot work fails the row", () => {
  // The default table in index.ts, as the row leaves every key out.
  const defaults = Config({});
  assert.equal(defaults.idleTimeoutMs, 300_000);
  assert.equal(defaults.commandTimeoutMs, 120_000);
  assert.equal(defaults.connectTimeoutSec, 10);
  assert.equal(defaults.maxOutputBytes, 1 << 20);
  assert.equal(defaults.batchMode, true);
  assert.equal(defaults.sshBinary, "ssh");
  assert.deepEqual(defaults.sshOptions, []);
  assert.equal(dirname(defaults.controlDir), tmpdir());
  assert.match(basename(defaults.controlDir), /^dsh-lazy-ssh-\d+$/);

  // Only the six ssh-facing keys cross into the transport; the two command
  // defaults stay with the pool.
  const ssh = resolveSshConfig({ ...defaults, sshOptions: ["-p", "2222"] });
  assert.deepEqual(ssh, {
    sshBinary: "ssh",
    controlDir: defaults.controlDir,
    connectTimeoutSec: 10,
    idleTimeoutMs: 300_000,
    batchMode: true,
    sshOptions: ["-p", "2222"],
  });

  // A duration or a byte count that cannot work fails while the row mounts,
  // rather than in a first call that looks like a network problem.
  for (const [key, value, pattern] of [
    ["idleTimeoutMs", 0, /idleTimeoutMs must be a positive number/],
    ["idleTimeoutMs", -1, /idleTimeoutMs must be a positive number/],
    ["commandTimeoutMs", Number.NaN, /commandTimeoutMs must be a positive number/],
    ["connectTimeoutSec", 1.5, /connectTimeoutSec must be a positive integer/],
    ["maxOutputBytes", 0, /maxOutputBytes must be a positive integer/],
  ]) {
    assert.throws(() => resolveSshConfig({ ...defaults, [key]: value }), pattern);
  }
  assert.throws(() => resolveSshConfig({ ...defaults, sshBinary: "   " }), /sshBinary must name an executable/);
  assert.throws(() => resolveSshConfig({ ...defaults, controlDir: "" }), /controlDir must name a directory/);

  // The extra options are copied: a row that mutates its array afterwards must
  // not be able to change the argv a transport already holds.
  const options = ["-p", "2222"];
  const resolved = resolveSshConfig({ ...defaults, sshOptions: options });
  options.push("-oProxyCommand=evil");
  assert.deepEqual(resolved.sshOptions, ["-p", "2222"]);
});

await check("ensureControlDir creates the control directory 0700 and re-secures an existing one", async () => {
  const scratch = await scratchDir("lazy-ssh-ctl-");
  try {
    // Created from nothing, including the missing parent: the plugin calls this
    // while mounting, so it must not need the directory to pre-exist.
    const nested = join(scratch.dir, "missing", "control");
    ensureControlDir(nested);
    assert.equal(statSync(nested).mode & 0o777, 0o700, "a fresh control directory must be private");

    // The socket is a credential, so an existing directory with looser bits is
    // tightened rather than trusted: it may have been created by an earlier run.
    writeFileSync(join(nested, "keep.txt"), "still here\n");
    ensureControlDir(nested);
    assert.equal(statSync(nested).mode & 0o777, 0o700, "an existing control directory must be re-secured");
    assert.ok(statSync(join(nested, "keep.txt")).isFile(), "re-securing must not empty the directory");

    // A directory that cannot exist is a row that fails while mounting, not a
    // first call that trips over a missing socket.
    writeFileSync(join(scratch.dir, "plain-file"), "not a directory\n");
    assert.throws(
      () => ensureControlDir(join(scratch.dir, "plain-file", "control")),
      /cannot create or secure the ssh control directory/,
    );
  } finally {
    await scratch.cleanup();
  }
});

await check("validateDestination refuses what ssh would read as an option or cannot be a host", () => {
  // Each refusal is one documented rule, named in the error so a model reading
  // the failure learns which part of its argument was wrong.
  assert.throws(() => validateDestination(""), /empty/);
  assert.throws(() => validateDestination("   "), /empty/);
  assert.throws(() => validateDestination("-oProxyCommand=touch /tmp/pwned"), /begin with/);
  assert.throws(() => validateDestination("deploy@build-01 with a space"), /whitespace/);
  assert.throws(() => validateDestination("host\tother"), /whitespace/);

  // And a destination that is one is left alone: the validation must not be a
  // filter that happens to reject everything.
  for (const good of ["build-01", "deploy@build-01", "build-01.example.com", "deploy@build-01:2222"]) {
    assert.doesNotThrow(() => validateDestination(good), `${good} is a destination ssh accepts`);
  }
});

await check("commandArgv is the documented option block, in order, then options, destination, command", () => {
  const config = baseConfig({
    sshBinary: "/nonexistent/bin/ssh",
    controlDir: "/nonexistent/control/lazy-ssh",
    connectTimeoutSec: 7,
    idleTimeoutMs: 300_000,
    batchMode: true,
    sshOptions: ["-p", "2222", "-oStrictHostKeyChecking=accept-new"],
  });

  const argv = commandArgv(config, "deploy@build-01", "uname -a");

  assert.deepEqual(argv, [
    "/nonexistent/bin/ssh",
    ...expectedOptionBlock(config, "deploy@build-01"),
    // Extra options travel verbatim, before the destination — ssh reads options
    // positionally, so a `-p` after the destination would be a remote command.
    "-p",
    "2222",
    "-oStrictHostKeyChecking=accept-new",
    "deploy@build-01",
    // The command is one element: it is model text for the REMOTE shell, and a
    // locally split command line would be a different program.
    "uname -a",
  ]);
});

await check("ControlPersist is the idle timeout plus the documented grace", () => {
  // The constant itself is part of the documented boundary, so it is pinned to
  // its literal before it is used to compute anything.
  assert.equal(CONTROL_PERSIST_GRACE_SEC, DOCUMENTED_CONTROL_PERSIST_GRACE_SEC);

  // `ControlPersist` is the master's own backstop for a shutdown that ran no
  // handler; the module states it as the idle timeout plus the grace, rounded up
  // to whole seconds.
  for (const idleTimeoutMs of [500, 1_000, 1_500, 300_000, 3_600_000]) {
    const config = baseConfig({ idleTimeoutMs });
    const argv = commandArgv(config, "host", "true");
    const persist = argv.find((element) => element.startsWith("ControlPersist="));
    const expected = Math.ceil(idleTimeoutMs / 1000) + DOCUMENTED_CONTROL_PERSIST_GRACE_SEC;
    assert.equal(persist, `ControlPersist=${expected}`, `idleTimeoutMs=${idleTimeoutMs}`);
  }
});

await check("BatchMode is exactly one option, present or absent per config", () => {
  const on = commandArgv(baseConfig({ batchMode: true }), "host", "true");
  const off = commandArgv(baseConfig({ batchMode: false }), "host", "true");

  assert.equal(on.filter((element) => element === "BatchMode=yes").length, 1);
  assert.equal(on[on.indexOf("BatchMode=yes") - 1], "-o");
  // Off means the option is not there at all, not passed with a different value.
  assert.ok(!off.some((element) => element.startsWith("BatchMode")), off.join(" "));

  // Both forms still end with the same destination and command.
  for (const argv of [on, off]) {
    assert.deepEqual(argv.slice(-2), ["host", "true"]);
  }
});

await check("ControlPath is one digest under controlDir, shared with the release and split per destination and options", () => {
  const config = baseConfig({ controlDir: "/nonexistent/control", sshOptions: ["-p", "2222"] });
  const path = controlPathFor(config, "deploy@build-01");
  const command = commandArgv(config, "deploy@build-01", "true");
  const release = releaseArgv(config, "deploy@build-01");

  // The socket lives under the configured directory — the only place the package
  // may leave a credential behind — and is named by a digest rather than by the
  // destination, which would blow the Unix socket path limit.
  const commandControlPath = command.find((element) => element.startsWith("ControlPath="));
  assert.equal(commandControlPath, `ControlPath=${path}`);
  const observedPath = commandControlPath.slice("ControlPath=".length);
  assert.equal(dirname(observedPath), config.controlDir);
  assert.match(basename(observedPath), /^[0-9a-f]{16}\.sock$/);

  // The release must reach the very socket the command built; a release for some
  // other path would leave the master running.
  assert.deepEqual(release, [config.sshBinary, "-o", `ControlPath=${path}`, "-O", "exit", "deploy@build-01"]);

  // Two rows that differ only in extra options — a different port, say — must not
  // share a master, and two destinations must not either.
  const controlPathOf = (argv) => argv.find((element) => element.startsWith("ControlPath="));
  const otherOptions = commandArgv({ ...config, sshOptions: ["-p", "2223"] }, "deploy@build-01", "true");
  const otherHost = commandArgv(config, "deploy@build-02", "true");
  assert.notEqual(controlPathOf(otherOptions), `ControlPath=${path}`, "a different port must not reuse the socket");
  assert.notEqual(controlPathOf(otherHost), `ControlPath=${path}`, "a different destination must not reuse the socket");
});

await check("a first call reports fresh, a call while the connection is held reports reused", async () => {
  const { pool, released, calls } = fakePool();
  try {
    const first = await pool.run({ destination: "build-01", command: "one" });
    const second = await pool.run({ destination: "build-01", command: "two" });
    const other = await pool.run({ destination: "build-02", command: "three" });

    assert.equal(first.connection, "fresh");
    assert.equal(second.connection, "reused");
    // Reuse is per destination, never global.
    assert.equal(other.connection, "fresh");
    assert.equal(calls.length, 3);
    assert.deepEqual(released, []);
  } finally {
    await pool.dispose();
  }
});

await check("a call inside the idle window postpones the release past the original deadline", async () => {
  // The window is deliberately wide relative to the waits: this check reasons
  // about WHEN a timer may fire, so a loaded machine must not be able to turn a
  // late poll into a false release.
  const idle = 400;
  const { pool, released } = fakePool({ idleTimeoutMs: idle });
  try {
    await pool.run({ destination: "build-01", command: "one" });

    await wait(200);
    assert.deepEqual(released, [], "the window has not elapsed yet");

    const second = await pool.run({ destination: "build-01", command: "two" });
    assert.equal(second.connection, "reused", "the call inside the window must reuse the connection");

    // Past the point where the FIRST call's window would have expired, and short
    // of where the refresh puts it. A pool that armed the timer once, from the
    // first call, has released by now.
    await wait(250);
    assert.deepEqual(released, [], "the later call must postpone the release, not merely reset it");

    // And the release does happen one full window after the LAST call.
    await waitFor(() => released.length === 1, { label: "the postponed idle release", timeoutMs: 3000 });
  } finally {
    await pool.dispose();
  }
});

await check("once the window passes, the connection is released exactly once and the next call is fresh", async () => {
  const idle = 250;
  const { pool, released } = fakePool({ idleTimeoutMs: idle });
  try {
    await pool.run({ destination: "build-01", command: "one" });
    assert.deepEqual(released, [], "no release before the window");

    await waitFor(() => released.length === 1, { label: "the idle release", timeoutMs: 3000 });
    assert.deepEqual(released, ["build-01"]);

    // Exactly once: a second release would be a second ssh process for a master
    // that is already gone.
    await wait(idle + 100);
    assert.deepEqual(released, ["build-01"], "the release must happen once, not repeatedly");

    const again = await pool.run({ destination: "build-01", command: "two" });
    assert.equal(again.connection, "fresh", "after a release the pool must not believe it still holds one");
  } finally {
    await pool.dispose();
  }
});

await check("a call still in flight keeps the connection past the idle deadline of an earlier one", async () => {
  const idle = 200;
  const first = deferred();
  const second = deferred();
  const { pool, released, calls } = fakePool({
    idleTimeoutMs: idle,
    run: (_destination, command) => (command === "one" ? first.promise : second.promise),
  });
  try {
    // Both enter the pool before either settles. Rule 1 is what makes the second
    // one `reused`: the entry is created before the first `await`.
    const one = pool.run({ destination: "build-01", command: "one" });
    const two = pool.run({ destination: "build-01", command: "two" });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].destination, "build-01");

    // The second call finishes first, so the pool has one call left in flight and
    // must not arm the release for the finished one.
    second.resolve(runResult({ stdout: "two\n" }));
    const twoResult = await two;
    assert.equal(twoResult.connection, "reused");

    await wait(idle + 150);
    assert.deepEqual(released, [], "a call still in flight must keep the connection open");

    first.resolve(runResult({ stdout: "one\n" }));
    const oneResult = await one;
    assert.equal(oneResult.connection, "fresh");

    // The window starts when the LAST call finishes, not when the first did.
    await waitFor(() => released.length === 1, { label: "the release after the last call", timeoutMs: 3000 });
  } finally {
    await pool.dispose();
  }
});

await check("a failure in one call does not discard the connection another call is using", async () => {
  // Rule 2, in both orders. A rejected call says nothing about the connection a
  // sibling call may be building, so only the last user may drop the entry.
  for (const failing of ["second", "first"]) {
    const one = deferred();
    const two = deferred();
    const { pool, released } = fakePool({
      idleTimeoutMs: 60_000,
      run: (_destination, command) =>
        command === "one" ? one.promise : command === "two" ? two.promise : Promise.resolve(runResult()),
    });
    try {
      const first = pool.run({ destination: "build-01", command: "one" });
      const second = pool.run({ destination: "build-01", command: "two" });

      if (failing === "second") {
        two.reject(new Error("transport could not start"));
        await assert.rejects(second, /transport could not start/);
        one.resolve(runResult());
        await first;
      } else {
        one.reject(new Error("transport could not start"));
        await assert.rejects(first, /transport could not start/);
        two.resolve(runResult());
        await second;
      }

      const survivor = await pool.run({ destination: "build-01", command: "three" });
      assert.equal(survivor.connection, "reused", `the failing ${failing} call must not drop the entry`);
      assert.deepEqual(released, []);
    } finally {
      await pool.dispose();
    }
  }
});

await check("a rejected call propagates and the next call to that server starts fresh", async () => {
  let fail = true;
  const { pool } = fakePool({
    run: () => (fail ? Promise.reject(new Error("could not start the ssh process")) : Promise.resolve(runResult())),
  });
  try {
    await assert.rejects(pool.run({ destination: "build-01", command: "one" }), /could not start the ssh process/);

    // The pool dropped what it could no longer vouch for, so the next call does
    // not claim to reuse a connection whose state is unknown.
    fail = false;
    const next = await pool.run({ destination: "build-01", command: "two" });
    assert.equal(next.connection, "fresh");
  } finally {
    await pool.dispose();
  }
});

await check("a cancelled call rejects rather than resolving, and the signal reaches the process", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    const controller = new AbortController();
    const started = Date.now();
    // The remote command never returns, so only the caller's cancellation can end
    // this call before its own four-second deadline.
    const pending = pool.run({
      destination: "deploy@build-01",
      command: "block 5",
      timeoutMs: 4_000,
      signal: controller.signal,
    });

    await wait(150);
    controller.abort(new Error("the turn was cancelled"));

    // A cancelled call has no result to report, so it must REJECT. A dropped
    // signal would instead let the deadline fire and resolve with
    // `timedOut: true` — the distinction the seam promises.
    await assert.rejects(pending, (error) => error !== undefined && error !== null);
    assert.ok(Date.now() - started < 2_000, "the abort, not the deadline, must end the call");

    // The cancelled call drops the entry: the pool cannot vouch for a connection
    // whose call was cut off mid-flight.
    const next = await pool.run({ destination: "deploy@build-01", command: "printf 'ok\\n'" });
    assert.equal(next.connection, "fresh");
    assert.equal(next.stdout, "ok\n");
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("a destination that is not one is refused before the transport is consulted", async () => {
  const { pool, calls } = fakePool();
  try {
    await assert.rejects(pool.run({ destination: "", command: "true" }), /empty/);
    await assert.rejects(pool.run({ destination: "-oProxyCommand=x", command: "true" }), /begin with/);
    await assert.rejects(pool.run({ destination: "two words", command: "true" }), /whitespace/);
    assert.deepEqual(calls, [], "no ssh process may be started for a destination that was refused");
  } finally {
    await pool.dispose();
  }
});

await check("dispose releases every held connection and refuses further work", async () => {
  const { pool, released } = fakePool();
  await pool.run({ destination: "build-01", command: "one" });
  await pool.run({ destination: "build-02", command: "two" });

  await pool.dispose();

  assert.deepEqual([...released].sort(), ["build-01", "build-02"]);
  await assert.rejects(pool.run({ destination: "build-01", command: "three" }), /disposed/);

  // The idle timers must be gone too: a release that fires after dispose would
  // be an ssh process started during shutdown.
  await wait(150);
  assert.deepEqual([...released].sort(), ["build-01", "build-02"]);
});

await check("dispose releases a connection whose call is still in flight, without waiting for it", async () => {
  // Rule 3: shutdown is not the moment to keep a session alive, and a graceful
  // exit that waits on a slow remote command is a hang.
  const pending = deferred();
  const { pool, released, calls } = fakePool({ run: () => pending.promise });
  const one = pool.run({ destination: "build-01", command: "one" });
  assert.equal(calls.length, 1, "the call must be in flight before dispose runs");

  let disposeSettled = false;
  const disposing = pool.dispose().then(() => {
    disposeSettled = true;
  });
  await wait(50);

  assert.equal(disposeSettled, true, "dispose must not wait for the call in flight");
  assert.deepEqual(released, ["build-01"], "it must still release the connection that call is using");
  await disposing;

  // The finish of the un-awaited call must not re-arm a timer on a disposed pool.
  pending.resolve(runResult());
  const settled = await one;
  assert.equal(settled.connection, "fresh");
  await wait(150);
  assert.deepEqual(released, ["build-01"]);
});

await check("abort calls the synchronous release for every held connection and clears its timers", async () => {
  const idle = 100;
  const { pool, released, detached } = fakePool({ idleTimeoutMs: idle });
  await pool.run({ destination: "build-01", command: "one" });
  await pool.run({ destination: "build-02", command: "two" });

  pool.abort();

  assert.deepEqual([...detached].sort(), ["build-01", "build-02"]);
  assert.deepEqual(released, [], "abort must not wait on the asynchronous release");

  // No idle timer may survive the abort: this runs while the process is dying,
  // and a timer that fires afterwards has nowhere to report.
  await wait(idle + 150);
  assert.deepEqual(released, [], "abort must clear the pending idle timers");
});

await check("the real seam is asked to build exactly one master across a fresh call and its reuse", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    const first = await pool.run({ destination: "deploy@build-01", command: "printf 'one\\n'" });
    const second = await pool.run({ destination: "deploy@build-01", command: "printf 'two\\n'" });

    assert.equal(first.connection, "fresh");
    assert.equal(second.connection, "reused");
    assert.equal(first.stdout, "one\n");
    assert.equal(second.stdout, "two\n");

    const events = readEvents(seam.logPath);
    const commands = events.filter((event) => event.kind === "CMD");
    assert.equal(commands.length, 2, "one ssh process per call, no probe and no extra connection");
    assert.equal(commands[0].detail, "master", "the first call is the one that builds the connection");
    assert.equal(commands[1].detail, "join", "the second call must join the connection, not build a second");
    assert.equal(commands.filter((event) => event.detail === "master").length, 1);

    // Both calls carry the same ControlPath, which is what makes the join a join.
    assert.equal(commands[0].control, commands[1].control);
    // And what reached the process is exactly what the package documents.
    assert.deepEqual(commands[0].argv, commandArgv(seam.config, "deploy@build-01", "printf 'one\\n'").slice(1));
    assert.deepEqual(commands[1].argv, commandArgv(seam.config, "deploy@build-01", "printf 'two\\n'").slice(1));
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("the real seam releases an idle master with -O exit once, and the next call is fresh again", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam, { idleTimeoutMs: 250 });
  try {
    const first = await pool.run({ destination: "deploy@build-01", command: "printf 'one\\n'" });
    assert.equal(first.connection, "fresh");

    await waitFor(() => readEvents(seam.logPath).some((event) => event.kind === "REL"), {
      label: "the release of the idle master",
      timeoutMs: 3000,
    });

    const releases = readEvents(seam.logPath).filter((event) => event.kind === "REL");
    assert.equal(releases.length, 1, "exactly one release process per idle master");
    assert.equal(releases[0].detail, "present", "the release must reach a master that is still listening");
    assert.deepEqual(releases[0].argv, releaseArgv(seam.config, "deploy@build-01").slice(1));

    await wait(300);
    assert.equal(readEvents(seam.logPath).filter((event) => event.kind === "REL").length, 1);

    // The master is gone, so this call dials again — and says so.
    const again = await pool.run({ destination: "deploy@build-01", command: "printf 'three\\n'" });
    assert.equal(again.connection, "fresh");
    assert.equal(again.stdout, "three\n");
    assert.equal(
      readEvents(seam.logPath).filter((event) => event.kind === "CMD" && event.detail === "master").length,
      2,
      "a fresh call after a release must build a new master",
    );
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("the real seam returns the exit status and both streams of one call", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    const result = await pool.run({
      destination: "deploy@build-01",
      command: "printf 'out\\n'; printf 'err\\n' 1>&2; exit 4",
    });

    // A non-zero status is a result, not a rejection: the model reads the status
    // and the streams together.
    assert.equal(result.exitCode, 4);
    assert.equal(result.stdout, "out\n");
    assert.equal(result.stderr, "err\n");
    assert.equal(result.timedOut, false);
    assert.equal(result.truncated, false);
    assert.equal(result.connection, "fresh");
    assert.equal(result.destination, "deploy@build-01");
    assert.equal(result.command, "printf 'out\\n'; printf 'err\\n' 1>&2; exit 4");
    assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0, `durationMs=${result.durationMs}`);
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("a command that outlives its own deadline is killed, reported timedOut, and loses no output it already wrote", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    const started = Date.now();
    // `block …` is the fake ssh's command that never returns; `timeoutMs` is the
    // per-command backstop, and the call must not hang on it.
    const result = await pool.run({ destination: "deploy@build-01", command: "block 5", timeoutMs: 300 });
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, true);
    // A killed child has no exit code, and the seam flattens that to -1 so every
    // caller reads an integer.
    assert.equal(result.exitCode, -1);
    assert.equal(result.stdout, "partial-output\n", "output written before the kill is still reported");
    assert.ok(elapsed < 5000, `the call must end at its deadline, not at the remote command's: ${elapsed} ms`);
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("the deadline settles the call at its deadline even while the child's pipes are still held open", async () => {
  // The regression this pins is a live one, found against a real sshd with a
  // remote `sleep 30` under an 800 ms deadline: the call SETTLED at 30.02 s, with
  // ssh's own 255, because it resolved on the child's `close`. A multiplexing ssh
  // client hands its standard streams to the master over the control socket, so
  // when the client dies the master keeps the pipes and `close` waits for the
  // REMOTE command. The fake ssh's `orphan` command is that shape: it starts a
  // writer that inherits its stdout and stderr and outlives it, prints one line,
  // and exits 255 at once. Only the writer closing the pipes, two seconds later,
  // lets the child's `close` fire.
  //
  // The earlier deadline check cannot see this: its `block` command is a shell
  // loop that dies on SIGTERM and takes its pipes with it, so `close` arrives
  // promptly and a resolve-on-close runner looks correct.
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    const started = Date.now();
    const result = await pool.run({ destination: "deploy@build-01", command: "orphan", timeoutMs: 300 });
    const elapsed = Date.now() - started;

    // Roughly the deadline, and nowhere near the writer's two seconds.
    assert.ok(
      elapsed < 1_500,
      `the call must settle at its deadline, not when the writer lets go of the pipes: ${elapsed} ms`,
    );
    assert.equal(result.timedOut, true);
    // `-1`, not the 255 the child itself exited with: the deadline is the bound,
    // so the settled result describes the kill rather than the child's status.
    assert.equal(result.exitCode, -1);
    // Everything that had arrived before the deadline is still reported...
    assert.equal(result.stdout, "early-line\n");
    // ...and collection stops there: the late line is never in the result.
    assert.ok(!result.stdout.includes("late-line"), "collection must stop when the call settles");

    // And no stray writer: its last act is to record that it finished, so the
    // check waits for that instead of returning while it still holds the pipes.
    await waitFor(() => readEvents(seam.logPath).some((event) => event.kind === "ORPHAN"), {
      label: "the inherited-stream writer to finish",
      timeoutMs: 6_000,
    });
  } finally {
    // However the assertions went, do not leave the writer running.
    await waitFor(() => readEvents(seam.logPath).some((event) => event.kind === "ORPHAN"), {
      label: "the inherited-stream writer to finish",
      timeoutMs: 6_000,
    }).catch(() => {});
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("the SIGKILL rung still fires for a child that ignores SIGTERM and holds its pipes open", async () => {
  // The other half of the new contract: the settle is about the promise, not
  // about the process, so the five-second SIGKILL must NOT be cancelled by it.
  // A child that ignores SIGTERM and holds a pipe open never reports `close`, so
  // if that rung were dropped with the settle this process would spin forever —
  // a leaked ssh nobody would ever reap.
  const seam = await realSeam();
  let pid;
  try {
    const started = Date.now();
    const result = await nodeRunner(commandArgv(seam.config, "deploy@build-01", "stubborn"), {
      cwd: process.cwd(),
      timeoutMs: 250,
      maxOutputBytes: 1 << 16,
    });
    const elapsed = Date.now() - started;

    assert.equal(result.timedOut, true);
    assert.equal(result.code, -1);
    assert.equal(result.stdout, "stubborn-started\n");
    assert.ok(elapsed < 1_000, `the call must settle at its deadline, not wait for the child: ${elapsed} ms`);

    // The child recorded its own pid before it started ignoring signals.
    const pidFile = `${seam.logPath}.pid`;
    await waitFor(
      () => {
        try {
          pid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
        } catch {
          pid = undefined;
        }
        return Number.isInteger(pid) && pid > 0;
      },
      { label: "the child to record its pid", timeoutMs: 2_000 },
    );

    // SIGTERM was delivered at the deadline and it is deliberately still there:
    // the settle did not, and must not, fake the child's death.
    assert.equal(processAlive(pid), true, "a TERM-ignoring child survives the deadline signal");

    await waitFor(() => !processAlive(pid), {
      label: "the SIGKILL the deadline armed five seconds later",
      timeoutMs: 8_000,
      intervalMs: 100,
    });
  } finally {
    // A failed check must not leave the spinning child behind.
    if (pid !== undefined && processAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone between the check and the kill.
      }
    }
    await seam.cleanup();
  }
});

await check("output past maxOutputBytes is capped and marked truncated", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam, { maxOutputBytes: 256 });
  try {
    // One thousand bytes of digits; the cap is 256.
    const command = "i=0; while [ $i -lt 100 ]; do printf '0123456789'; i=$((i+1)); done";
    const result = await pool.run({ destination: "deploy@build-01", command });

    assert.equal(result.truncated, true);
    assert.equal(result.stdout.length, 256, "exactly the cap is kept, and nothing more");
    assert.equal(result.stdout, "0123456789".repeat(25) + "012345");
    assert.equal(result.exitCode, 0, "a stream that was cut is not a failed command");
  } finally {
    await pool.dispose();
    await seam.cleanup();
  }
});

await check("a transport that cannot start at all rejects instead of producing a result", async () => {
  const seam = await realSeam();
  const missing = { ...seam.config, sshBinary: join(seam.dir, "no-such-ssh-binary") };
  try {
    const transport = new SshTransport(nodeRunner, missing);
    await assert.rejects(
      transport.run("deploy@build-01", "true", { timeoutMs: 5_000, maxOutputBytes: 1024 }),
      (error) => error instanceof Error && /ENOENT|spawn/.test(`${error.code ?? ""} ${error.message}`),
      "an executable that does not exist must reject, not resolve with a fabricated status",
    );

    // The pool must not swallow it either: a call that never reached a server has
    // no result to report.
    const pool = new SshPool(transport, { idleTimeoutMs: 60_000, commandTimeoutMs: 5_000, maxOutputBytes: 1024 });
    await assert.rejects(pool.run({ destination: "deploy@build-01", command: "true" }));
  } finally {
    await seam.cleanup();
  }
});

await check("dispose over the real seam releases every master it is holding", async () => {
  const seam = await realSeam();
  const pool = seamPool(seam);
  try {
    await pool.run({ destination: "deploy@build-01", command: "true" });
    await pool.run({ destination: "deploy@build-02", command: "true" });

    await pool.dispose();

    const releases = readEvents(seam.logPath).filter((event) => event.kind === "REL");
    assert.equal(releases.length, 2, "one release per held connection, none for a server never dialled");
    assert.deepEqual(
      releases.map((event) => event.control).sort(),
      [
        controlPathFor(seam.config, "deploy@build-01"),
        controlPathFor(seam.config, "deploy@build-02"),
      ].sort(),
    );
  } finally {
    await seam.cleanup();
  }
});

report();
