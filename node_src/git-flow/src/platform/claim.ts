/**
 * The claim file: which branch and which worktree each session family owns.
 *
 * A claim is the durable answer to "which working tree does this session write
 * in". The file belongs to the repository but is not repository content: it names
 * absolute machine-local paths, so it must stay out of every commit — see below.
 *
 * ## One instance, one lock
 *
 * A store holds the claim file **open and exclusively locked** for its whole
 * lifetime: {@link ClaimStore.open} takes the lock, {@link ClaimStore.dispose}
 * releases it, and every query and every write happens inside that window.
 * Mutating the file through one open descriptor is what makes "read the claim,
 * then change it" a single critical section instead of two operations another
 * process can interleave — and it is why no separate lock file is needed, with
 * its own stale-lock deadlock.
 *
 * A lock another process holds is **waited for**, never blocked on and never
 * failed on sight: the wait runs on the event loop and is bounded, so a peer that
 * died holding the lock cannot wedge this process.
 *
 * ## Format
 *
 * TOML, one table per family, keyed by the root session id:
 *
 * ```toml
 * [claims.session-ea4ebc37-0e8e-4dbd-9a70-f1f442c58c0c]
 * branch = "feature/git-flow-rewrite"
 * worktreeName = "session-ea4ebc37"
 * createdAt = "2026-09-13T00:34:56.840Z"
 * ```
 *
 * ## Keep it out of git
 *
 * The file lives under the repository's main working tree and **must be listed in
 * `.gitignore`**. This module does not write one and adds no rule of its own: a
 * claim that reaches a commit carries machine-local absolute paths into the
 * shared history, and `git add --all` will pick it up unless it is ignored.
 *
 * ## Layer
 *
 * The platform: the outside world. This layer starts processes and reads and
 * writes files, and it imports nothing above it — neither `core` nor the
 * boundary. The dependency only ever points down.
 *
 * @module @dsh-external/dotdsh-git-flow/claim
 */

import type { FileHandle } from "node:fs/promises";

/**
 * The claim file, relative to the repository's main working tree.
 *
 * Hardcoded for now. Its directory must appear in `.gitignore` — this module
 * never stages it, but nothing else knows to exclude it either.
 */
const CLAIM_FILE = ".dsh.local/git-flow.toml";

/**
 * How long {@link ClaimStore.open} waits for a peer's lock before giving up.
 *
 * Hardcoded for now, like every other path and bound in this rewrite. It only has
 * to outlast a peer's claim write, which is a read-modify-write of one small
 * file; anything longer than this is a peer that is not coming back, and waiting
 * for it would be the deadlock this design exists to avoid.
 */
const LOCK_TIMEOUT_MS = 2000;

/** One family's claim, as the claim file records it. */
export interface Claim {
  /** Root of the family's delegation chain — the table key this record is stored under. */
  readonly sessionId: string;
  /** The family's feature branch. */
  readonly branch: string;
  /** Directory name of the family's worktree, under the repository's worktree root. */
  readonly worktreeName: string;
  /**
   * When the claim was written, ISO-8601.
   *
   * Diagnostics only: nothing decides on it. It is there so a claim found later —
   * one whose session never finished, or two records for one tree — can be
   * explained by whoever has to clean it up.
   */
  readonly createdAt: string;
}

/**
 * The claim file, held open and locked.
 *
 * One instance per repository, and one operation at a time through it. A store
 * that outlives its usefulness is worse than no store at all, because the lock
 * lives as long as the instance does, so `dispose` belongs in a `finally`.
 */
export class ClaimStore {
  /** Absolute path of the repository's main working tree; every path this store uses derives from it. */
  readonly repoRoot: string;
  /** The open file, whose descriptor carries the exclusive lock. */
  private readonly handle: FileHandle;

  /**
   * Build a store around an already-locked file.
   *
   * Private, and it stays that way: {@link ClaimStore.open} is the only way to an
   * instance, because the lock has to be in hand before any method is called.
   */
  private constructor(repoRoot: string, handle: FileHandle) {
    throw new Error("ClaimStore is not implemented");
  }

  /**
   * Open the repository's claim file and lock it.
   *
   * Creates the file and its directory when they are not there yet. A lock held
   * by another process is waited for on the event loop, up to
   * {@link LOCK_TIMEOUT_MS}; once that passes, this throws rather than waiting
   * forever, and the caller decides whether the family may proceed without a
   * claim.
   *
   * @param repoRoot - absolute path of the repository's main working tree.
   * @returns a locked store, which the caller must {@link ClaimStore.dispose}.
   */
  static async open(repoRoot: string): Promise<ClaimStore> {
    throw new Error("ClaimStore.open is not implemented");
  }

  /**
   * Release the lock and close the file.
   *
   * The destructor of this class: everything else in it is only valid before this
   * runs. Safe to call once; calling it twice is a caller bug.
   */
  dispose(): Promise<void> {
    throw new Error("ClaimStore.dispose is not implemented");
  }

  /**
   * The claim recorded for one family.
   *
   * @param sessionId - root of the family's delegation chain.
   * @returns the record, or `undefined` when this family has no claim — which is
   *   a normal state, not an error.
   */
  query(sessionId: string): Promise<Claim | undefined> {
    throw new Error("ClaimStore.query is not implemented");
  }

  /**
   * Record a new claim.
   *
   * The caller owns the record's contents, including {@link Claim.createdAt};
   * this store only decides where it is written. A claim whose session is already
   * recorded replaces it, so the file holds at most one tree per family.
   *
   * @param claim - the record to write.
   */
  append(claim: Claim): Promise<void> {
    throw new Error("ClaimStore.append is not implemented");
  }

  /**
   * Drop the claim recorded for one family.
   *
   * Removing a claim that is not there is a no-op, because releasing a family is
   * the one operation that has to be retryable.
   *
   * @param sessionId - root of the family's delegation chain.
   */
  remove(sessionId: string): Promise<void> {
    throw new Error("ClaimStore.remove is not implemented");
  }
}
