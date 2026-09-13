/**
 * The process seam: the one place this plugin starts a process.
 *
 * Nothing above this module calls `node:child_process`. The pool hands the
 * transport a {@link Runner}, the transport hands it an argv, and the committed
 * checks hand the pool a runner of their own — which is what lets `pnpm test`
 * drive the whole lazy-session protocol (reuse, idle release, cancellation,
 * output handling) against a fake `ssh` on a scratch directory, with no server,
 * no network and no harness present.
 *
 * ## What a runner guarantees
 *
 * - **argv is verbatim.** The executable and every argument are separate
 *   elements, and no shell is involved. A remote command is model-supplied text
 *   and is meant to be read by the *remote* shell; a destination or a command
 *   that quotes its way out of a locally built command line is a class of bug
 *   this seam makes impossible rather than unlikely.
 * - **`timeoutMs` is the bound, not the child's exit.** When the deadline passes
 *   the child is signalled — `SIGTERM`, then `SIGKILL` five seconds later if it is
 *   still there — and the call settles *immediately* with `timedOut: true`, a
 *   `-1` status and whatever was already collected. Waiting for the child to exit
 *   is not the same thing as bounding the call, and the difference is not
 *   theoretical: a multiplexing ssh client hands its standard streams to the
 *   master over the control socket, so when the client dies the master keeps the
 *   pipes — and a call that resolves on `close` then hangs until the *remote*
 *   command finishes, which for `tail -f` is never. The child, and whatever
 *   inherited its streams, may therefore outlive the call — and so do the two
 *   read ends this seam keeps draining, until whoever holds the other end lets
 *   go. This is the per-command backstop; it is not the idle release, which is
 *   the pool's business.
 * - **`signal` is the caller's cancellation.** An abort rejects the call rather
 *   than resolving it: a cancelled call has no result to report, and the caller
 *   that aborted already knows why. `timeoutMs` and `signal` are therefore
 *   distinguishable in the result, which is what an agent needs in order to tell
 *   "the server was slow" from "the turn was cancelled".
 * - **`maxOutputBytes` bounds each stream.** At most that many bytes are kept per
 *   stream; anything past it is still drained and discarded, and the result says
 *   `truncated: true`. A remote command that decides to print a gigabyte must not
 *   decide how much memory this process uses.
 * - **`code` is total.** A child killed by a signal reports `-1` rather than
 *   `null`, so every caller reads an integer. A non-zero code is a *result*, not
 *   a rejection: ssh exits 255 for its own failures and otherwise passes the
 *   remote command's status through, and the model needs to read both.
 *
 * ## Layer
 *
 * The platform: the outside world. This layer starts processes and reads and
 * writes files, and it imports nothing above it — neither `core` nor the
 * boundary. The dependency only ever points down.
 *
 * @module @dsh-external/dotdsh-lazy-ssh/exec
 */

import { spawn } from "node:child_process";

/** One finished process, or one the deadline took away from its caller. */
export interface RunResult {
  /**
   * Exit code, or `-1` when there was none to report: a signal ended the child,
   * or the deadline settled the call before the child was done.
   */
  readonly code: number;
  /** Decoded standard output, capped at the caller's `maxOutputBytes`. */
  readonly stdout: string;
  /** Decoded standard error, capped at the caller's `maxOutputBytes`. */
  readonly stderr: string;
  /**
   * Whether this call hit its deadline and was settled there.
   *
   * It describes the call, not the process: the child may have exited on its own
   * before the deadline, and it may still be alive after it.
   */
  readonly timedOut: boolean;
  /** Whether either stream was cut off at `maxOutputBytes`. */
  readonly truncated: boolean;
}

/** What one process invocation needs. */
export interface RunnerOptions {
  /** Directory the child runs in. ssh does not read it; being explicit is the point. */
  readonly cwd: string;
  /**
   * Wall-clock budget for the whole child, in milliseconds.
   *
   * Required rather than optional: every call this plugin makes has a deadline,
   * and a child nobody is waiting for is a leak with a friendlier name. The
   * backstop is this value; the *reuse* window is the pool's idle timeout.
   */
  readonly timeoutMs: number;
  /** Per-stream cap; each stream keeps at most this many bytes. */
  readonly maxOutputBytes: number;
  /** Cancellation owned by the caller. Aborting rejects the call. */
  readonly signal?: AbortSignal;
  /** Environment entries layered over the runner's own. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Anything that can run one child to completion and report what happened.
 *
 * The whole plugin's testability rests on this being the only place a process is
 * started.
 */
export type Runner = (
  argv: readonly [string, ...string[]],
  options: RunnerOptions,
) => Promise<RunResult>;

/**
 * The standalone runner: `node:child_process` with no shell.
 *
 * Both the plugin in production and the committed checks use this one. It is not
 * built on the harness's `subprocess` service, and the reason is the subject of
 * the plugin rather than a shortcut: what this plugin runs is *this machine's*
 * `ssh`, reaching *this user's* `~/.ssh` and the servers that trust it. The
 * harness's subprocess world may be a sandbox with neither, so binding to it
 * would make the tool's behaviour depend on a composition detail that has nothing
 * to do with ssh. The trade-off this seam accepts, stated plainly: an ssh child
 * is not tracked by the harness's own process accounting, so this plugin's
 * teardown — the pool's release and the process-exit hook that backs it — is the
 * only thing that ends one.
 *
 * The timeout is enforced here rather than by the caller so that the kill ladder
 * has exactly one implementation: the child is signalled with `SIGTERM`, a child
 * that is still alive five seconds later is sent `SIGKILL`, and the call settles
 * at the deadline rather than at the child's exit — see the module header for why
 * those are two different moments.
 *
 * @param argv - the executable followed by its arguments, passed verbatim.
 * @param options - directory, deadline, output cap, cancellation and environment.
 * @returns the exit code, both decoded streams, and how the call ended.
 * @throws the abort reason when `options.signal` aborts the call.
 */
export function nodeRunner(
  argv: readonly [string, ...string[]],
  options: RunnerOptions,
): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const cap = options.maxOutputBytes;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const stdoutKept = { bytes: 0 };
    const stderrKept = { bytes: 0 };
    let truncated = false;

    // Byte-exact, not character-exact: a chunk is cut at the remaining room, and
    // only what falls past the cap is dropped. The listener stays attached, so
    // the stream is still drained even after the cap is reached.
    const collect = (chunks: Buffer[], kept: { bytes: number }, chunk: Buffer): void => {
      const room = cap - kept.bytes;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length <= room) {
        chunks.push(chunk);
        kept.bytes += chunk.length;
        return;
      }
      chunks.push(Buffer.from(chunk.subarray(0, room)));
      kept.bytes = cap;
      truncated = true;
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      collect(stdoutChunks, stdoutKept, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      collect(stderrChunks, stderrKept, chunk);
    });

    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const decode = (code: number): RunResult => ({
      code,
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      timedOut,
      truncated,
    });

    const clearTimers = (): void => {
      clearTimeout(deadlineTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
    };

    /**
     * Stop collecting without stopping the drain.
     *
     * The listeners go and `resume()` keeps the streams flowing into nothing, so
     * a writer that still holds the other end — the multiplexing master, after
     * the client it was handed the pipes by is gone — never blocks on a full
     * pipe. `destroy()` would be the tidier-looking call and is the wrong one: it
     * makes the stream emit an error nobody is listening for any more.
     */
    const stopCollecting = (): void => {
      for (const stream of [child.stdout, child.stderr]) {
        stream?.removeAllListeners("data");
        stream?.resume();
      }
    };

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      // A child that ignores SIGTERM must not be able to hold its slot forever.
      // Deliberately not cleared when the timeout settles the call below: the
      // settle is about this promise, not about the process.
      killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, 5000);
      stopCollecting();
      settle(decode(-1));
    }, options.timeoutMs);

    const settle = (result: RunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    // Covers both a child that could not start (ENOENT and friends) and the
    // abort Node raises when `options.signal` fires; `close` may still follow,
    // and the first settlement is the one that counts. After a deadline settle,
    // a late error has nothing left to report and is swallowed.
    child.on("error", (error: Error) => {
      if (settled) return;
      clearTimers();
      settled = true;
      reject(error);
    });

    child.on("close", (code: number | null) => {
      clearTimers();
      settle(decode(code ?? -1));
    });
  });
}

/**
 * Start a process that must outlive the caller, and do not wait for it.
 *
 * This exists for exactly one moment: teardown. A plugin disposer may run while
 * the event loop is being torn down, so the release of a multiplexed master
 * cannot be awaited there — the child is started detached, with all three
 * standard streams discarded, and unref'd so it never holds the process open.
 * The process-exit hook that calls this runs while Node is shutting down, where
 * nothing asynchronous can be awaited at all.
 *
 * Failures are deliberately silent: this is a best-effort cleanup path, and a
 * teardown that throws is worse than a socket file left behind. It is also not
 * the last line of defence: `SIGKILL` runs no handler at all, so the case where
 * even this does not run falls to ssh's own `ControlPersist` — which bounds an
 * abandoned idle master and nothing else. `ssh.ts` states the whole boundary.
 *
 * @param argv - the executable followed by its arguments, passed verbatim.
 */
export function spawnDetached(argv: readonly [string, ...string[]]): void {
  try {
    const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" });
    // A start failure arrives asynchronously on `error`, not as a throw; without
    // a listener Node would surface it as an uncaught exception, which is not
    // the silence this path promises.
    child.on("error", () => {});
    child.unref();
  } catch {
    // Teardown is best-effort: a release that cannot start is the socket's
    // business, and a teardown that throws is worse than a socket left behind.
  }
}
