/**
 * The lazy-session pool: one connection per server, held open until it has been
 * idle long enough to be worth closing.
 *
 * This is the core of the plugin and the only place that has an opinion about
 * lifetime. It maps a destination to the connection the plugin believes is
 * carrying it, counts the calls that are using it, and arms one timer per server
 * from the moment its last call finishes. A call that arrives while the timer
 * runs clears it and re-arms it afterwards, which is what "reuse the connection
 * and refresh the timeout" means mechanically: the server goes idle exactly
 * `idleTimeoutMs` after the *last* call, never after the first.
 *
 * ## What it deliberately does not know
 *
 * It does not know what ssh is, only what a {@link SshTransport} can do; it does
 * not know what a tool is, only that somebody wants a command run. That is what
 * lets the committed checks drive the whole lifetime protocol — reuse, refresh,
 * idle release, dispose, abort — against a fake transport, and separately against
 * a fake `ssh`, with no server anywhere.
 *
 * ## Failure, and what the caller can act on
 *
 * A command that exits non-zero is a *result*: the model needs ssh's own
 * diagnosis on stderr and the remote command's status, and turning that into an
 * exception would hide both. Only three things reject a call: the caller's own
 * cancellation, a destination that is not one, and a transport that could not
 * start the process at all. A rejected call also drops the server's entry — the
 * pool can no longer say what state that connection is in — but only when it was
 * the last call using it; the second rule below is the qualifier, and the next
 * call establishes a new connection and reports it `fresh`.
 *
 * ## Three rules the design walk pinned down
 *
 * 1. **The entry is created synchronously, before the first `await`.** Two calls
 *    that arrive together for a server nobody has dialled yet must not both
 *    report `fresh` and race to own the connection: the first one to run creates
 *    the entry, and the second finds it.
 * 2. **A rejected call drops the entry only when it is the last one using it.**
 *    Two concurrent calls, one of which cannot start a process at all, say
 *    nothing about the connection the other one may be building.
 * 3. **`dispose` does not wait for calls in flight.** It releases every
 *    connection, which ends those calls where they stand. Shutdown is not the
 *    moment to keep a session alive, and a graceful exit that waits on a slow
 *    remote command is a hang.
 *
 * ## Deferred
 *
 * **A liveness probe before each call.** Today `connection` is bookkeeping — what
 * this pool believed when the call started — not a measurement. A real answer
 * would cost one `ssh -O check` per call, which is a whole extra process on the
 * path this plugin exists to shorten. Named here rather than silently dropped:
 * the field's name is `connection`, and a reader should not mistake it for proof.
 *
 * **A read-only view of what is held open.** A future `ssh_sessions` tool would
 * answer "is anything still connected to that box?" from the connection table
 * this module already keeps. It is not built, because one tool was asked for and
 * a second tool is a second schema for the model to choose between; when it is
 * wanted, the table is here and this module is where the answer comes from. No
 * snapshot type ships ahead of that consumer — an unused public view is a promise
 * nothing keeps.
 *
 * ## Layer
 *
 * The core: the pool's lifetime logic, with no knowledge of dsh. It imports
 * `platform` and nothing above it — the boundary is a caller, not a dependency.
 *
 * @module @dsh-external/dotdsh-lazy-ssh/pool
 */

import type { SshTransport } from "../platform/ssh.js";
import { validateDestination } from "../platform/ssh.js";

/** One command to run on one server. */
export interface SshRequest {
  /** The validated ssh destination, for example `deploy@build-01`. */
  readonly destination: string;
  /** The remote command; interpreted by the remote shell. */
  readonly command: string;
  /** This call's deadline, overriding the pool's default. */
  readonly timeoutMs?: number;
  /** Cancellation owned by the caller; an abort rejects the call. */
  readonly signal?: AbortSignal;
}

/** What one call did. */
export interface SshResult {
  /** The destination the command ran on. */
  readonly destination: string;
  /** The command as it was sent. */
  readonly command: string;
  /** The remote command's exit status, or `-1` when a signal ended the call. */
  readonly exitCode: number;
  /** Decoded standard output, capped by the pool's output limit. */
  readonly stdout: string;
  /** Decoded standard error, capped by the pool's output limit. */
  readonly stderr: string;
  /**
   * Whether the pool already held a connection for this destination.
   *
   * Bookkeeping, not a probe: see the module's *Deferred* note.
   */
  readonly connection: "reused" | "fresh";
  /** Wall-clock duration of the call, in milliseconds. */
  readonly durationMs: number;
  /** Whether the call hit its deadline and was killed. */
  readonly timedOut: boolean;
  /** Whether either stream was cut off at the output limit. */
  readonly truncated: boolean;
}

/** How the pool behaves, resolved from the row's config. */
export interface PoolOptions {
  /** How long a connection may sit idle before it is released. */
  readonly idleTimeoutMs: number;
  /** Default deadline for one command, when the call does not set one. */
  readonly commandTimeoutMs: number;
  /** Per-stream output cap. */
  readonly maxOutputBytes: number;
  /** The clock; injectable so a check can reason about idle time without waiting for it. */
  readonly now?: () => number;
}

/**
 * One connection the pool is holding, and the timer that will end it.
 *
 * Mutable, private, and the only record of what this plugin has left open. The
 * fields are exactly the state the lifetime protocol reads and nothing else: a
 * call counter or a last-used timestamp would only feed a view that does not
 * exist yet, and a field with no reader is the next reviewer's question.
 */
interface Connection {
  readonly destination: string;
  /** Calls currently using this connection. */
  inFlight: number;
  /** The pending idle release, or `undefined` while a call is in flight. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The pool. */
export class SshPool {
  /** The ssh-facing half this pool drives. */
  private readonly transport: SshTransport;
  /** How the pool behaves. */
  private readonly options: Required<PoolOptions>;
  /** Every connection currently believed live, by destination. */
  private readonly connections = new Map<string, Connection>();
  /** Set by {@link dispose}; a disposed pool refuses further work. */
  private disposed = false;

  /**
   * Bind a transport to one set of lifetimes.
   *
   * @param transport - the ssh transport every call goes through.
   * @param options - idle timeout, default command deadline, output cap and clock.
   */
  constructor(transport: SshTransport, options: PoolOptions) {
    this.transport = transport;
    this.options = { now: Date.now, ...options };
  }

  /**
   * Run one command, reusing the destination's connection when there is one.
   *
   * The call clears the destination's idle timer before it starts and re-arms it
   * when the last in-flight call finishes, so a burst of calls keeps one
   * connection and the timeout is refreshed by every one of them.
   *
   * @param request - destination, command, and optional deadline and cancellation.
   * @returns the remote exit status, both streams, and how the call went.
   * @throws Error when the pool has been disposed, or when the destination is not one.
   * @throws the abort reason when the caller cancels the call.
   */
  async run(request: SshRequest): Promise<SshResult> {
    if (this.disposed) {
      throw new Error("SshPool is disposed and accepts no further work");
    }
    validateDestination(request.destination);

    const { destination } = request;
    let entry = this.connections.get(destination);
    const connection: "reused" | "fresh" = entry === undefined ? "fresh" : "reused";
    if (entry === undefined) {
      // Rule 1: the entry exists before the first `await` below, so two calls
      // that arrive together cannot both report `fresh` and race to own it.
      entry = { destination, inFlight: 0, timer: undefined };
      this.connections.set(destination, entry);
    }

    // A call makes the destination busy, so its idle release is no longer due.
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.inFlight += 1;

    const startedAt = this.options.now();
    let rejected = true;
    try {
      const result = await this.transport.run(destination, request.command, {
        timeoutMs: request.timeoutMs ?? this.options.commandTimeoutMs,
        maxOutputBytes: this.options.maxOutputBytes,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      });
      const sshResult: SshResult = {
        destination,
        command: request.command,
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        connection,
        durationMs: this.options.now() - startedAt,
        timedOut: result.timedOut,
        truncated: result.truncated,
      };
      rejected = false;
      return sshResult;
    } finally {
      entry.inFlight -= 1;
      // Only the entry that is still the current one, with no call left using
      // it, may act: a release or a disposal may have taken the destination away.
      if (this.connections.get(destination) === entry && entry.inFlight === 0) {
        if (rejected) {
          // Rule 2: only the last user may drop the entry. A failure while a
          // sibling call is still in flight says nothing about the connection
          // that call may be building, so the entry stays for it.
          this.connections.delete(destination);
        } else {
          entry.timer = setTimeout(() => {
            // Delete before releasing: a call that starts while the release is
            // in flight must see `fresh`, never join a master that is exiting.
            this.connections.delete(destination);
            // `release` promises never to reject; this only guards a bug in it.
            void this.transport.release(destination).catch(() => {});
          }, this.options.idleTimeoutMs);
          entry.timer.unref();
        }
      }
    }
  }

  /**
   * Release every connection and refuse further calls.
   *
   * Called when the plugin unmounts or the profile shuts down. It waits for each
   * master to exit, because a graceful shutdown has the time; the process-exit
   * hook and {@link abort} cover the shutdowns that do not.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    const held = [...this.connections.values()];
    this.connections.clear();
    for (const entry of held) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
    }
    // Rule 3: calls in flight are deliberately not awaited. Releasing each
    // connection ends them where they stand, which is the point of shutdown.
    await Promise.all(held.map((entry) => this.transport.release(entry.destination)));
  }

  /**
   * Release every connection without waiting — the last thing before the process dies.
   *
   * Synchronous by necessity: it is called from a `process.on("exit")` handler,
   * where the event loop is already over. It starts each release and returns;
   * whether any of them completed is not observable from here, which is why ssh's
   * own `ControlPersist` exists as the final backstop — and that backstop is a
   * bounded one: it closes an idle master, never one with a call in flight. A
   * `SIGKILL` gets neither this method nor the hook that calls it; `ssh.ts` states
   * what is left in that case.
   */
  abort(): void {
    const held = [...this.connections.values()];
    this.connections.clear();
    for (const entry of held) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
    }
    for (const entry of held) {
      try {
        this.transport.detachRelease(entry.destination);
      } catch {
        // One destination that cannot be released must not stop the rest.
      }
    }
  }
}
