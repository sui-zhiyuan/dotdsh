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
 * - **`timeoutMs` always kills.** When the deadline passes the child is signalled
 *   and the call resolves with `timedOut: true`, carrying whatever it had already
 *   written to either stream. This is the per-command backstop; it is not the
 *   idle release, which is the pool's business.
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

/** One finished process. */
export interface RunResult {
  /** Exit code, or `-1` when a signal ended the child instead of an exit. */
  readonly code: number;
  /** Decoded standard output, capped at the caller's `maxOutputBytes`. */
  readonly stdout: string;
  /** Decoded standard error, capped at the caller's `maxOutputBytes`. */
  readonly stderr: string;
  /** Whether `timeoutMs` expired and the child was killed for it. */
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
 * has exactly one implementation: the child is signalled with `SIGTERM`, and the
 * resolved result carries the partial output either way.
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
  throw new Error(`nodeRunner is not implemented: ${argv[0]} (cwd ${options.cwd})`);
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
  throw new Error(`spawnDetached is not implemented: ${argv[0]}`);
}
