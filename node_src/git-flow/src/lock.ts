/**
 * The repository's claim lock.
 *
 * Claiming is a read-modify-write of one JSON file shared by every session that
 * works in the repository, so it happens under this lock. `O_EXCL` is enforced by
 * the kernel, not by the process, so one mechanism covers both cases that matter —
 * two sessions of one dsh process (the ordinary case) and two dsh processes — and
 * it was measured rather than assumed: 200 concurrent create-new opens in one
 * process produce exactly one winner.
 *
 * Four obligations follow from doing this over a filesystem, and each one has a
 * failure that is silent if it is skipped:
 *
 * - **the critical section must not await git.** Two sessions of one process share
 *   an event loop, so a holder waiting on a subprocess leaves the other session's
 *   write spinning behind it. Everything the decision needs from git is computed
 *   before the lock is taken.
 * - **waiting is asynchronous and jittered.** A busy-wait would block the event
 *   loop, which in the same-process case blocks the very holder whose release is
 *   being waited for. Jitter is for fairness: two processes racing an unfair lock
 *   split 45/3 in the measurement.
 * - **release is compare-and-delete on a token.** When a stale lock is broken the
 *   old holder is still inside its section with no idea it lost the lock; a bare
 *   `unlink` would then delete the *new* holder's file and let a third claimant in.
 * - **a live holder is not broken on a timeout alone.** The critical section is
 *   filesystem work and cannot take a minute, so only a dead pid — or an age far
 *   beyond any plausible section, which is what a foreign lock from a shared mount
 *   looks like — justifies breaking in.
 *
 * Two limits are worth naming. On a network mount `O_EXCL` is emulated client-side
 * by older NFS and the pid describes another machine's process space, so exclusion
 * there is best-effort and only the age test recovers a dead holder. And two
 * machines sharing one checkout are out of scope, for the same reason the ledger
 * holds absolute machine-local paths.
 *
 * @module @dsh-external/dotdsh-git-flow/lock
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Git } from "./exec.js";
import { isProcessAlive, localDir } from "./repo.js";

/** How long to wait for the lock before telling the caller it could not be taken. */
const ACQUIRE_TIMEOUT_MS = 10_000;

/**
 * How long a lock file may sit before it counts as abandoned regardless of its pid.
 *
 * Only a shared mount makes this reachable with a live-looking pid: within one
 * machine a dead holder is caught by the pid, and a live one cannot be inside a
 * filesystem-only critical section for a minute.
 */
const HARD_STALE_MS = 60_000;

/** First retry delay, doubled up to {@link MAX_BACKOFF_MS} and jittered. */
const MIN_BACKOFF_MS = 4;
const MAX_BACKOFF_MS = 100;

/** What the lock file holds while it is held. */
export interface LockHolder {
  /** Unique per acquisition, so a release can tell whose lock this is. */
  readonly token: string;
  /** The holding process, for the dead-holder test. */
  readonly pid: number;
  /** ISO timestamp, for the abandoned-holder test. */
  readonly at: string;
}

/**
 * Tell whether a lock file is abandoned.
 *
 * Exported for the committed check: the difference between "held" and "abandoned"
 * is the whole safety argument for breaking one, and it is a plain function of the
 * holder and the clock.
 *
 * A holder with no pid is one whose file was created but never written — a crash
 * between the two — so nobody is inside a section that never started.
 *
 * @param holder - what the lock file said.
 * @param now - the current time in milliseconds.
 * @returns whether the lock may be broken.
 */
export function isAbandoned(holder: LockHolder, now: number): boolean {
  if (!isProcessAlive(holder.pid)) return true;
  if (holder.at === "") return false;
  return now - Date.parse(holder.at) > HARD_STALE_MS;
}

/** Thrown when the lock could not be taken in time. */
export class LockTimeoutError extends Error {
  /**
   * @param path - the lock file.
   * @param ms - how long the caller waited.
   */
  constructor(path: string, ms: number) {
    super(`could not take the repository lock at ${path} within ${String(ms)}ms`);
    this.name = "LockTimeoutError";
  }
}

/** A held lock. */
export interface LockHandle {
  /**
   * Release the lock.
   *
   * A no-op when the lock is no longer ours, which is what makes breaking a stale
   * lock safe: the broken holder's release must not delete its successor's file.
   *
   * @returns resolution once the lock file is gone or known to be someone else's.
   */
  release(): Promise<void>;
}

/**
 * Absolute path of the lock file for a repository.
 *
 * Beside the ledger, under the main working tree, so every worktree and every
 * process resolves the same file.
 *
 * @param git - any client for the repository.
 * @returns the lock file path.
 */
export function lockPath(git: Git): Promise<string> {
  return localDir(git).then((dir) => join(dir, "git-flow.lock"));
}

/**
 * Wait for a duration.
 *
 * @param ms - milliseconds to wait.
 * @returns resolution after the wait.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Read the lock file's contents.
 *
 * @param path - the lock file.
 * @returns the holder, or `undefined` when the file is gone or unreadable.
 */
async function readHolder(path: string): Promise<LockHolder | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed.token !== "string" || typeof parsed.pid !== "number") return undefined;
    return { token: parsed.token, pid: parsed.pid, at: typeof parsed.at === "string" ? parsed.at : "" };
  } catch {
    // A half-written lock file is what a crash between create and write looks
    // like. Treating it as a holder with no pid means the next pass breaks it,
    // which is the right outcome: nobody is inside a section that never started.
    return { token: "", pid: 0, at: "" };
  }
}

/**
 * Create the lock file, if it is free.
 *
 * @param path - the lock file.
 * @param token - this acquisition's token.
 * @returns the handle, or `undefined` when someone else holds the lock.
 */
async function tryCreate(path: string, token: string): Promise<LockHandle | undefined> {
  let file;
  try {
    file = await open(path, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
    throw error;
  }

  const holder: LockHolder = { token, pid: process.pid, at: new Date().toISOString() };
  try {
    await file.writeFile(JSON.stringify(holder));
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(path).catch(() => undefined);
    throw error;
  }
  await file.close();

  return {
    async release(): Promise<void> {
      const current = await readHolder(path);
      if (current?.token !== token) return;
      await unlink(path).catch(() => undefined);
    },
  };
}

/**
 * Remove a lock whose holder is gone.
 *
 * The file is read twice around the decision so that a holder which released and
 * had its lock taken by someone else in between is not deleted by this pass. The
 * window is not closed — a compare-and-delete is not available over a plain file —
 * but it is reachable only through the age test, which a process on this machine
 * cannot trigger while it is still running.
 *
 * @param path - the lock file.
 * @returns whether a stale lock was removed, so the caller can retry at once.
 */
async function breakIfStale(path: string): Promise<boolean> {
  const first = await readHolder(path);
  if (first === undefined) return false;
  if (!isAbandoned(first, Date.now())) return false;

  const second = await readHolder(path);
  if (second === undefined || second.token !== first.token) return false;
  await unlink(path).catch(() => undefined);
  return true;
}

/**
 * Take the lock, waiting for it if it is held.
 *
 * @param path - the lock file.
 * @param timeoutMs - how long to wait before giving up.
 * @returns the held lock.
 * @throws LockTimeoutError when the lock is still held after the timeout.
 */
async function acquire(path: string, timeoutMs: number): Promise<LockHandle> {
  const token = `${String(process.pid)}-${randomUUID()}`;
  const deadline = Date.now() + timeoutMs;
  let delay = MIN_BACKOFF_MS;

  for (;;) {
    const handle = await tryCreate(path, token);
    if (handle !== undefined) return handle;
    if (await breakIfStale(path)) continue;
    if (Date.now() >= deadline) throw new LockTimeoutError(path, timeoutMs);
    await sleep(MIN_BACKOFF_MS + Math.random() * delay);
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  }
}

/**
 * Run one read-modify-write of the claim ledger under the lock.
 *
 * `body` must be filesystem work only. Everything it needs from git has to be
 * resolved by the caller first: a git call inside this section blocks every other
 * session of the same process, because they share an event loop.
 *
 * @param git - any client for the repository.
 * @param body - the critical section.
 * @param options - `timeoutMs` overrides how long to wait for the lock.
 * @returns whatever the section returned.
 * @throws LockTimeoutError when the lock could not be taken.
 */
export async function withLock<T>(
  git: Git,
  body: () => Promise<T>,
  options: { readonly timeoutMs?: number } = {},
): Promise<T> {
  const path = await lockPath(git);
  await mkdir(dirname(path), { recursive: true });
  const handle = await acquire(path, options.timeoutMs ?? ACQUIRE_TIMEOUT_MS);
  try {
    return await body();
  } finally {
    await handle.release();
  }
}
