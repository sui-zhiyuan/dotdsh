/**
 * The ssh vocabulary: what one call to a server looks like on the wire, and the
 * one process seam that runs it.
 *
 * ## The reuse this plugin exists for
 *
 * The plain `ssh host "command"` a shell tool runs pays for a TCP handshake, a
 * key exchange and an authentication on *every* call. OpenSSH already knows how
 * to pay that once: the first connection can become a **master** that keeps the
 * authenticated transport open on a Unix socket, and every later client that
 * names the same `ControlPath` runs its own session over that existing
 * connection. What OpenSSH does not decide is how long to keep one; that is the
 * pool's idle timeout, and this module is the vocabulary the pool speaks.
 *
 * The alternative — one long-lived `ssh` process with a shell on the far side,
 * commands fed to its stdin — was rejected deliberately. Framing that protocol
 * means inventing delimiters, exit codes, stderr separation, per-command
 * cancellation and a way to survive a command that closes the pipe, and every
 * one of those is a way to attribute one command's output to another. With
 * multiplexing, each call is its own ssh process with its own streams and its own
 * exit status, and only the connection is shared — which is exactly the cost that
 * was being paid over and over. A single command still runs in a single remote
 * shell, so `cd` does not persist between calls; join steps with `&&` instead.
 *
 * ## Who ends a connection
 *
 * Three paths, and the third one is the one to be honest about:
 *
 * - **Normally, this plugin.** The pool's per-server idle timer calls
 *   {@link SshTransport.release}, which asks the master to exit. That is the
 *   timeout the user configured, observed exactly.
 * - **On a graceful shutdown.** Cordis disposes the plugin, which releases every
 *   master, and a `process.on("exit")` hook repeats the release for a shutdown
 *   that got no further than `process.exit`.
 * - **After a hard kill, ssh itself — with a hole in it.** `SIGKILL` runs no
 *   handler at all, so neither of the above happens. What is left is
 *   `ControlPersist`, which every client here sets to the idle timeout plus
 *   {@link CONTROL_PERSIST_GRACE_SEC}: an *idle* master closes itself within that
 *   window. A call still in flight is a different story — the master has a client,
 *   so it is not idle and `ControlPersist` never fires, and the orphaned client
 *   keeps both the connection and the remote command alive until that command
 *   ends. A remote command that never ends leaves both behind.
 *
 * Nothing in the process can close that hole: a `SIGKILL`ed process runs no code,
 * and OpenSSH detaches the master from it anyway — the binary calls glibc's
 * `daemon()` (fork plus `setsid`), so the master is in no session or process group
 * of ours and the terminal's `SIGINT` never reaches it. Closing the hole needs a
 * process of ours that outlives us; see *Deferred*.
 *
 * ## A deadline stops the waiting, not the command
 *
 * The same shape shows up in a single call. The client hands its standard streams
 * to the master over the control socket, so when a command hits its deadline and
 * the client is signalled, the master still carries the session: the call returns
 * — `nodeRunner` settles at the deadline, measured against real ssh rather than
 * assumed — while the remote command keeps running. Ending *that* would mean
 * ending the session, and the only handle this plugin has on a session is the
 * master that carries it. `commandTimeoutMs` is therefore a bound on how long the
 * model waits, and never a promise that the server stopped working.
 *
 * ## One process owns a connection
 *
 * The control directory is one per user, so two dsh processes running as the same
 * user find each other's masters: the second joins the first one's connection
 * instead of dialling again. That sharing is OpenSSH's own behaviour and costs
 * nothing while nobody releases the master — but this plugin does release it, and
 * `ssh -O exit` ends a master together with every session on it (where `-O stop`
 * is the one that only refuses new sessions). An idle release in one process can
 * therefore cut a command still running in another.
 *
 * So: **one dsh process per user and machine uses lazy ssh.** A deployment that
 * runs a second one gives it its own `controlDir` — the row's config, or that
 * profile's own patch layer — and the two keep to their own sockets. This is
 * documented rather than enforced, and the fix, if it is ever wanted, is the
 * socket's name: the digest below would take the process id, which costs the
 * sharing that makes a second process cheap and leaves the single-process case
 * this repository runs exactly as it is.
 *
 * ## Deferred
 *
 * **A keeper process per server.** A dead process cannot clean up after itself,
 * but the kernel will: hold the write end of a pipe, give the read end to a tiny
 * `sh` that starts ssh in the background and then blocks on `read`, and any death
 * — `SIGKILL` included — closes the pipe, ends the read, and lets the keeper
 * signal ssh. The mechanism was built and verified on Linux (`SIGKILL` of the
 * holder and a plain `stdin.end()` both ended the child within milliseconds). It
 * is not what this version does, for a reason worth stating: the master OpenSSH
 * daemonizes is not a process we own, so a keeper would have to *be* the master's
 * owner — start it with `-M -N`, wait for it to become ready, notice its death,
 * restart it — and every call would pay one more `sh`. That is real machinery,
 * and this version documents the window instead of buying it away. If the window
 * ever matters, this is where it gets closed, and the experiment above is where
 * to start.
 *
 * ## What this module never touches
 *
 * No credential of any kind is read, written, or passed. Authentication is
 * whatever `~/.ssh` already does — keys, agent, `config` — and this module adds
 * no mechanism that could carry a password. `BatchMode` defaults to on for the
 * same reason: a tool call cannot answer a prompt, so a host whose key is not
 * already trusted must fail with ssh's own message rather than hold the call
 * open until the timeout. Connect to a new host once by hand to accept its key,
 * or turn `batchMode` off in the row's config.
 *
 * The control socket is a credential in its own right: whoever can connect to it
 * inherits the authenticated connection. The directory holding it is therefore
 * created `0700`, and ssh keeps the socket itself `0600`.
 *
 * ## Layer
 *
 * The platform: the outside world. It imports {@link Runner} from `exec` and
 * nothing above it.
 *
 * @module @dsh-external/dotdsh-lazy-ssh/ssh
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { spawnDetached } from "./exec.js";
import type { RunResult, Runner } from "./exec.js";

/**
 * Everything about a server call that comes from the row's config.
 *
 * One value rather than eight parameters: every function below needs most of it,
 * and a caller that must remember to thread `idleTimeoutMs` into the argv builder
 * is a caller that can forget.
 */
export interface SshConfig {
  /** The ssh executable. Absolute, or a name resolved on `PATH`. */
  readonly sshBinary: string;
  /**
   * Directory holding the per-server control sockets. Created `0700`.
   *
   * One per user rather than one per process, so it is shared by every dsh process
   * running as that user — see the module's *One process owns a connection*.
   */
  readonly controlDir: string;
  /** `ConnectTimeout`, in seconds. Bounds the handshake, not the command. */
  readonly connectTimeoutSec: number;
  /**
   * How long a connection may sit idle before the pool releases it.
   *
   * Also the basis of `ControlPersist`: the master's own backstop is this value
   * plus {@link CONTROL_PERSIST_GRACE_SEC}.
   */
  readonly idleTimeoutMs: number;
  /** Whether to pass `-o BatchMode=yes`, which turns an unanswerable prompt into a failure. */
  readonly batchMode: boolean;
  /** Extra `-o`/flag arguments, inserted verbatim before the destination. */
  readonly sshOptions: readonly string[];
}

/**
 * Extra slack on top of the idle timeout before ssh's own backstop closes a master.
 *
 * It exists for a master nobody is left to release: `ControlPersist` counts idle
 * time, so this is how long an abandoned *idle* master survives a `SIGKILL` of
 * dsh. It does not bound a master with a call in flight — see the module's *Who
 * ends a connection*.
 */
export const CONTROL_PERSIST_GRACE_SEC = 30;

/** Per-call ceiling for the best-effort release and probe invocations. */
export const RELEASE_TIMEOUT_MS = 10_000;

/**
 * Output kept from a release invocation.
 *
 * Small on purpose: `ssh -O exit` answers with at most one short line, and this
 * cap exists only so the release path cannot be the one that grows a buffer.
 */
const RELEASE_MAX_OUTPUT_BYTES = 4_096;

/**
 * Refuse a destination that could be read as an option or cannot be a host.
 *
 * The destination is model-supplied and becomes the argument ssh dials, so a
 * value beginning with `-` would be parsed as an option — a destination is not
 * allowed to carry `-oProxyCommand=…` or anything else. Whitespace is refused
 * too: no ssh destination contains it, and one that does is a sign the model
 * meant two arguments.
 *
 * @param destination - the `ssh` destination, as the model wrote it.
 * @throws Error naming the rule that was broken.
 */
export function validateDestination(destination: string): void {
  if (destination.trim() === "") {
    throw new Error(`ssh destination must not be empty or only whitespace: ${JSON.stringify(destination)}`);
  }
  if (destination.startsWith("-")) {
    throw new Error(`ssh destination must not begin with "-" (ssh would read it as an option): ${JSON.stringify(destination)}`);
  }
  if (/\s/.test(destination)) {
    throw new Error(`ssh destination must not contain whitespace: ${JSON.stringify(destination)}`);
  }
}

/**
 * The control socket path for one destination.
 *
 * Derived from the destination and the configured extra options, so two rows
 * that differ only in `sshOptions` — a different port, say — never share a
 * master. The file name is a digest rather than the destination itself because a
 * Unix socket path is limited to about a hundred bytes and a destination is
 * arbitrary text.
 *
 * @param config - the row's ssh configuration.
 * @param destination - the validated ssh destination.
 * @returns an absolute path under `config.controlDir`.
 */
function controlPathFor(config: SshConfig, destination: string): string {
  const digest = createHash("sha256")
    .update(destination)
    .update("\0")
    .update(config.sshOptions.join("\0"))
    .digest("hex")
    .slice(0, 16);
  return join(config.controlDir, `${digest}.sock`);
}

/**
 * Create the control-socket directory if it is missing, and keep it private.
 *
 * Synchronous on purpose: the plugin calls it once while mounting, where a
 * failure should fail the row rather than the first tool call, and the
 * process-exit path has no room for a promise.
 *
 * @param controlDir - the directory to create.
 * @throws Error when the directory cannot be created or made `0700`.
 */
export function ensureControlDir(controlDir: string): void {
  try {
    mkdirSync(controlDir, { recursive: true, mode: 0o700 });
    chmodSync(controlDir, 0o700);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`cannot create or secure the ssh control directory ${controlDir}: ${reason}`, {
      cause,
    });
  }
}

/**
 * The argv of one multiplexed command call.
 *
 * `ControlMaster=auto` lets the first call become the master and every later call
 * join it, and it falls back to a plain connection when no master is listening —
 * so a master that died between calls costs one handshake, never a failed call.
 *
 * @param config - the row's ssh configuration.
 * @param destination - the validated ssh destination.
 * @param command - the remote command; one argv element, interpreted by the remote shell.
 * @returns the executable and its arguments, in order.
 */
export function commandArgv(
  config: SshConfig,
  destination: string,
  command: string,
): readonly [string, ...string[]] {
  const controlPersistSec = Math.max(
    1,
    Math.ceil(config.idleTimeoutMs / 1000) + CONTROL_PERSIST_GRACE_SEC,
  );

  const argv: string[] = [
    config.sshBinary,
    "-o",
    "ControlMaster=auto",
    "-o",
    `ControlPath=${controlPathFor(config, destination)}`,
    "-o",
    `ControlPersist=${controlPersistSec}`,
    "-o",
    `ConnectTimeout=${config.connectTimeoutSec}`,
  ];
  if (config.batchMode) {
    argv.push("-o", "BatchMode=yes");
  }
  argv.push(...config.sshOptions, destination, command);
  return argv as [string, ...string[]];
}

/**
 * The argv that asks a master to exit.
 *
 * `-O exit` reaches the running master over its control socket and tells it to
 * terminate; it starts no session and no connection. A missing master makes it
 * exit non-zero, which the caller treats as "already released".
 *
 * @param config - the row's ssh configuration.
 * @param destination - the validated ssh destination.
 * @returns the executable and its arguments, in order.
 */
export function releaseArgv(
  config: SshConfig,
  destination: string,
): readonly [string, ...string[]] {
  return [
    config.sshBinary,
    "-o",
    `ControlPath=${controlPathFor(config, destination)}`,
    "-O",
    "exit",
    destination,
  ];
}

/**
 * The ssh-facing half of the pool: build the calls, run them, end them.
 *
 * It owns no state. Which servers are believed connected, when each one goes
 * idle, and what to do about it are the pool's; this class only knows how to say
 * those things to ssh.
 */
export class SshTransport {
  /** The process seam every invocation goes through. */
  private readonly runner: Runner;
  /** The row's ssh configuration. */
  private readonly config: SshConfig;

  /**
   * Bind a runner to one ssh configuration.
   *
   * @param runner - the process seam; the same runner serves every transport.
   * @param config - the resolved ssh configuration.
   */
  constructor(runner: Runner, config: SshConfig) {
    this.runner = runner;
    this.config = config;
  }

  /**
   * Run one remote command over the server's multiplexed connection.
   *
   * @param destination - the validated ssh destination.
   * @param command - the remote command, interpreted by the remote shell.
   * @param options - the caller's deadline, output cap and cancellation for this call.
   * @returns ssh's result: the remote exit status, both streams, and how the call ended.
   * @throws the abort reason when the caller cancels.
   */
  run(
    destination: string,
    command: string,
    options: {
      readonly timeoutMs: number;
      readonly maxOutputBytes: number;
      readonly signal?: AbortSignal;
    },
  ): Promise<RunResult> {
    return this.runner(commandArgv(this.config, destination, command), {
      cwd: process.cwd(),
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  /**
   * Ask the master for one destination to exit, and tidy up its socket.
   *
   * Best effort by contract: it never throws, because it is called from an idle
   * timer and from teardown, where a rejected promise has no one to tell. A
   * master that is already gone is the common, harmless case.
   *
   * @param destination - the validated ssh destination.
   */
  release(destination: string): Promise<void> {
    return (async (): Promise<void> => {
      try {
        await this.runner(releaseArgv(this.config, destination), {
          cwd: process.cwd(),
          timeoutMs: RELEASE_TIMEOUT_MS,
          maxOutputBytes: RELEASE_MAX_OUTPUT_BYTES,
        });
      } catch {
        // Best effort by contract: a master that is already gone is harmless.
      }
      removeControlSocket(controlPathFor(this.config, destination));
    })();
  }

  /**
   * Ask a master to exit without waiting — the teardown path.
   *
   * Starts the same release as {@link release} and returns immediately, because
   * its callers are a disposer and a `process.on("exit")` hook, neither of which
   * can await anything. The socket is deliberately left in place: the release
   * process was only just started and needs it, and the master removes its own
   * socket when it exits.
   *
   * @param destination - the validated ssh destination.
   */
  detachRelease(destination: string): void {
    try {
      spawnDetached(releaseArgv(this.config, destination));
    } catch {
      // Best effort by contract: this runs during teardown, where there is no
      // one left to tell about a failure.
    }
  }
}

/** Remove one control socket if it is still there, ignoring every failure. */
function removeControlSocket(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Best effort: whoever is still listening removes its own socket.
  }
}
