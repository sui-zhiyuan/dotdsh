/**
 * The claim file: which branch and which worktree each session family owns.
 *
 * A claim is the durable answer to "which working tree does this session write
 * in". The file belongs to the repository but is not repository content: it names
 * absolute machine-local paths, so it must stay out of every commit — see below.
 *
 * ## One instance, one lock
 *
 * One store at a time, across processes, and the lock is a file beside the claim
 * file: **creating `<claimFile>.lock` is taking the lock and deleting it is
 * releasing it**, and a store holds it for its whole lifetime. Everything a store
 * does — the read on the way in, every `append` and `remove`, the read a `query`
 * or a `find` makes — is therefore one critical section, which is what turns "read
 * the claim, judge it, change it" into a single operation instead of two another
 * process can interleave. Readers take the lock too: this is one mutex over the
 * file and not a read-write lock, deliberately, because the decisions above this
 * module read and then write.
 *
 * The lock file is **not** a staging file. Nothing is ever renamed onto the claim
 * file and the lock is not released by moving it into place: it exists while a
 * store is open, for no other reason, and no reader of the claim file ever looks
 * at it.
 *
 * ## When the holder is gone
 *
 * A holder that crashes leaves the lock file behind, and the repository would be
 * locked out of its own claim file forever. So the lock file's **mtime** is the
 * whole expiry rule: an existing lock younger than
 * {@link FlowSettings.lockStaleSeconds} is held, and the caller is refused rather
 * than made to wait — the model or the human retries; one older than that is a
 * leftover, and a process takes it over by writing its own owner line over it —
 * the touch and the record of who holds the lock are the same write.
 *
 * That bound is only sound because a critical section is a few filesystem
 * operations on a small file: microseconds, not seconds. The invariant that keeps
 * it sound is that **no store is held across a git call** — `core`'s sweep takes
 * its snapshot and lets the lock go before it removes anything. Renewing the mtime
 * while the lock is held was considered and rejected: a heartbeat has to run on
 * the event loop, a long synchronous turn delays it, and the lock then looks
 * expired while it is still held. That is the failure mode `proper-lockfile` is
 * known for, and nothing under the bound needs renewal.
 *
 * **The gap this leaves, recorded rather than papered over:** two processes can
 * find the same expired lock and touch it in the same instant, and both then
 * believe they hold it. Closing it needs a primitive the filesystem does not
 * offer — `unlink` removes whatever is at the path now, not the file that was
 * judged — so the alternatives are an election over one file per contender, or
 * never taking a lock over at all. Both cost more than the window. For it to hurt,
 * two processes have to reach the same expired lock inside the same microsecond
 * *and* then interleave two read-modify-writes of the file.
 *
 * ## Why the descriptor does not carry it
 *
 * Node exposes no `flock`/`fcntl` locking: `fs.constants` holds no `LOCK_*` flag
 * and a `FileHandle` has no lock method, so an advisory lock cannot ride the
 * descriptor this store writes through. Node's answer is that a cross-platform
 * file lock is not a thing it provides — nodejs/node#49256 was closed as
 * not-planned on libuv's ruling that it is broken differently on every platform —
 * and this package takes no native dependency. What is left is a separate file
 * whose existence is the lock, which is what the section above describes.
 *
 * ## Format
 *
 * TOML, one table per family, keyed by the root session id, behind a fixed
 * three-line comment header that says what the file is:
 *
 * ```toml
 * # Machine-local state for the dsh git-flow plugin. It records which session works in
 * # which working tree, and its paths are absolute paths on this machine. It is not
 * # repository content: do not commit it.
 *
 * version = "0.1.0"
 *
 * [claims.session-ea4ebc37-0e8e-4dbd-9a70-f1f442c58c0c]
 * branch = "feat/git-flow-rewrite"
 * worktreeName = "git_flow_rewrite"
 * createdAt = "2026-09-13T00:34:56.840Z"
 * ```
 *
 * The session id is the table key and is not repeated inside the table: a second
 * copy of an identity is a second source of truth, and the two can disagree.
 * `version` is stamped and never read — it is there for a later format change to
 * branch on.
 *
 * ## Keep it out of git
 *
 * The file lives under the repository's main working tree and **must be listed in
 * `.gitignore`**. This module does not write one and adds no rule of its own: a
 * claim that reaches a commit carries machine-local absolute paths into the
 * shared history, and `git add --all` will pick it up unless it is ignored. The
 * lock file sits beside it in the same directory and is covered by the same rule.
 *
 * ## Layer
 *
 * The platform: the outside world. This layer starts processes and reads and
 * writes files, and it imports nothing above it — neither `core` nor the
 * boundary. The dependency only ever points down.
 *
 * @module @dsh-external/dotdsh-git-flow/claim
 */

import type { Stats } from "node:fs";
import { mkdir, open, readFile, stat, unlink, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";
import type { FlowContext } from "./context.js";

/**
 * The format version stamped into every document this module writes.
 *
 * Written and never read: nothing here validates it and nothing branches on it.
 * It is there so a later format change has a field to branch on rather than a
 * shape to guess at.
 */
const CLAIM_VERSION = "0.1.0";

/**
 * The comment block every document is written behind.
 *
 * `smol-toml` emits no comments, so the file's own account of itself — machine
 * local, not repository content, do not commit — has to be prepended by hand. The
 * trailing blank line is the one that separates the comments from the body.
 */
const CLAIM_HEADER = `# Machine-local state for the dsh git-flow plugin. It records which session works in
# which working tree, and its paths are absolute paths on this machine. It is not
# repository content: do not commit it.

`;

/**
 * The `worktreeName` that says a family works in the repository's **main** working
 * tree rather than in one of its own.
 *
 * A sentinel inside the name rather than an absent field or an empty string: the
 * row keeps the three strings it has always had, so neither the read nor the write
 * path changes and a claim always names the tree it holds. The brackets are what
 * make it unoccupiable — a real worktree's directory name is derived from a branch
 * subject, which is letters, digits and dashes only — so no family can be handed
 * this name by accident and no directory of that name can exist.
 */
export const MAIN_WORKTREE = "[MAIN]";

/** Suffix that turns the claim file's path into its lock file's path. */
const LOCK_SUFFIX = ".lock";

/**
 * How many times {@link acquireLock} retries the create after it found the lock
 * file gone.
 *
 * One retry is what happens in practice: the create failed because a peer held the
 * lock, and the peer released it in the microseconds before the stat below. The
 * bound is here so that a path that keeps vanishing cannot spin forever.
 */
const LOCK_CREATE_RETRIES = 3;

/** One family's claim, as the claim file records it. */
export interface Claim {
  /** Root of the family's delegation chain — the table key this record is stored under. */
  readonly sessionId: string;
  /** The family's feature branch. */
  readonly branch: string;
  /**
   * Directory name of the family's worktree, under the repository's worktree root,
   * or {@link MAIN_WORKTREE} when the family works in the repository's main working
   * tree instead. Never empty, and never a name a real worktree could take.
   */
  readonly worktreeName: string;
  /**
   * When the claim was written, ISO-8601.
   *
   * Diagnostics, and the sweep's age gate: a claim younger than a day is left
   * alone even when its session can no longer come back, because a human may be
   * about to reopen it. It is also the field that explains a claim found later —
   * one whose session never finished, or two records for one tree.
   */
  readonly createdAt: string;
}

/** One family's row as it is stored: a {@link Claim} without the identity the table key already carries. */
type ClaimRow = Omit<Claim, "sessionId">;

/**
 * The claim document as this module reads and writes it.
 *
 * Private, and it stays that way: the file's shape is this module's business, and
 * a caller works in {@link Claim} records.
 */
interface ClaimDocument {
  /** Stamped on every write, never read back. */
  readonly version: string;
  /** One row per family, keyed by the session id that identifies it. */
  readonly claims: Record<string, ClaimRow>;
}

/**
 * The claim file, held open — and the lock on it, held for the same lifetime.
 *
 * One instance per repository, and one operation at a time through it, across
 * processes: {@link ClaimStore.open} takes the lock and {@link ClaimStore.dispose}
 * releases it, so a store that outlives its usefulness is worse than no store at
 * all — there is nothing left to release it. `dispose` belongs in a `finally`,
 * exactly like the descriptor.
 */
export class ClaimStore {
  /** Absolute path of the repository's main working tree; the claim file and its lock are found from here. */
  readonly repoRoot: string;
  /** Absolute path of the claim file itself, resolved from the repository and the `claimFile` setting. */
  private readonly claimFilePath: string;
  /** The open file every read and write goes through. */
  private readonly handle: FileHandle;
  /** The lock file this store owns: created on the way in, removed by {@link ClaimStore.dispose}. */
  private readonly lockPath: string;

  /**
   * Build a store around an already-open file and an already-taken lock.
   *
   * Private, and it stays that way: {@link ClaimStore.open} is the only way to an
   * instance, because both the descriptor and the lock have to be in hand before
   * any method is called.
   */
  private constructor(repoRoot: string, claimFilePath: string, handle: FileHandle, lockPath: string) {
    this.repoRoot = repoRoot;
    this.claimFilePath = claimFilePath;
    this.handle = handle;
    this.lockPath = lockPath;
  }

  /**
   * Open the repository's claim file: take its lock, then read it.
   *
   * The lock comes first, because everything this store does afterwards is the
   * critical section it exists for. Creating the file and its directory when they
   * are not there yet is part of taking it, and the file is then read once, so a
   * document that cannot be read or parsed fails here rather than at the first
   * command a session runs — with the lock already given back.
   *
   * Where the file and its lock live, and how old a lock may be before it is taken
   * over, all come from the context's settings — this module hardcodes none of them.
   *
   * A lock another process holds is **not** waited for. This throws, and whoever is
   * above it — the model through a tool, the human through a command — runs the
   * operation again in a moment. The exception is a lock old enough to be a
   * leftover (see {@link FlowSettings.lockStaleSeconds}), which is taken over here.
   *
   * @param context - the settings this plugin resolved, the process seam, and the
   *   repository's main working tree.
   * @returns an open store, which the caller must {@link ClaimStore.dispose}.
   * @throws Error when another process holds the lock.
   */
  static async open(context: FlowContext): Promise<ClaimStore> {
    const claimFilePath = claimPathOf(context);
    const lockPath = `${claimFilePath}${LOCK_SUFFIX}`;
    await mkdir(dirname(claimFilePath), { recursive: true });
    await acquireLock(lockPath, context.settings.lockStaleSeconds * 1_000);
    try {
      const handle = await openClaimFile(claimFilePath);
      const store = new ClaimStore(context.repoRoot, claimFilePath, handle, lockPath);
      try {
        await store.readDocument();
      } catch (error) {
        // The read is a check on the file, not a use of it: a store that cannot read
        // its own file has no reason to keep the descriptor open.
        await handle.close();
        throw error;
      }
      // A file with no content — one this store just created, or an empty one some
      // earlier run left behind — and a session that only ever asks about its claim
      // never writes one. So the version is stamped here, where the file comes into
      // being, rather than waiting for a first claim that may never come.
      if ((await handle.stat()).size === 0) {
        await store.writeDocument({ version: CLAIM_VERSION, claims: {} });
      }
      return store;
    } catch (error) {
      // The lock is not the caller's to clean up: a store that never came into
      // being releases it before the error travels on.
      await releaseLock(lockPath);
      throw error;
    }
  }

  /**
   * Close the file and release the lock.
   *
   * The destructor of this class: everything else in it is only valid before this
   * runs. Safe to call once; calling it twice is a caller bug.
   */
  async dispose(): Promise<void> {
    try {
      await this.handle.close();
    } finally {
      // `finally` because a store whose close failed is still a store whose lock has
      // to go back, and the release itself never throws.
      await releaseLock(this.lockPath);
    }
  }

  /**
   * The claim recorded for one family.
   *
   * @param sessionId - root of the family's delegation chain.
   * @returns the record, or `undefined` when this family has no claim — which is
   *   a normal state, not an error.
   */
  async query(sessionId: string): Promise<Claim | undefined> {
    const document = await this.readDocument();
    const row: ClaimRow | undefined = document.claims[sessionId];
    if (row === undefined) return undefined;
    // The key is the identity, so the field comes back from the key, not the row.
    return {
      sessionId,
      branch: row.branch,
      worktreeName: row.worktreeName,
      createdAt: row.createdAt,
    };
  }

  /**
   * The claims this store holds, narrowed by branch and/or worktree name.
   *
   * Both criteria are optional and both are exact matches, so calling this with
   * neither asks for every claim the file holds — which is what a sweep needs,
   * since it exists to find the records nobody is going to ask about by name.
   *
   * @param criteria - the branch and/or worktree name to match on.
   * @returns the matching records, in the file's own order.
   */
  async find(criteria?: {
    readonly branch?: string;
    readonly worktreeName?: string;
  }): Promise<readonly Claim[]> {
    const document = await this.readDocument();
    const branch = criteria?.branch;
    const worktreeName = criteria?.worktreeName;

    const claims: Claim[] = [];
    for (const [sessionId, row] of Object.entries(document.claims)) {
      if (branch !== undefined && row.branch !== branch) continue;
      if (worktreeName !== undefined && row.worktreeName !== worktreeName) continue;
      claims.push({ sessionId, branch: row.branch, worktreeName: row.worktreeName, createdAt: row.createdAt });
    }
    return claims;
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
  async append(claim: Claim): Promise<void> {
    const document = await this.readDocument();
    // The key is the identity: the row is stored without repeating it.
    const { sessionId, ...row } = claim;
    document.claims[sessionId] = row;
    await this.writeDocument(document);
  }

  /**
   * Drop the claim recorded for one family.
   *
   * Removing a claim that is not there is a no-op, because releasing a family is
   * the one operation that has to be retryable.
   *
   * @param sessionId - root of the family's delegation chain.
   */
  async remove(sessionId: string): Promise<void> {
    const document = await this.readDocument();
    if (!Object.hasOwn(document.claims, sessionId)) return;
    delete document.claims[sessionId];
    await this.writeDocument(document);
  }

  /**
   * Read the file as it is now and turn it into a document.
   *
   * The read goes by path rather than through the open handle: `FileHandle.readFile`
   * reads from the descriptor's own offset and leaves it at end of file, so a
   * second read through it would come back empty. Writes stay on the handle, which
   * is where the lock will live.
   *
   * A row missing any of the three fields, or carrying one that is not a string,
   * throws instead of being dropped: a dropped claim reads as "no claim", and the
   * next family would take a tree that is still spoken for. Anything else a row
   * carries is ignored rather than preserved — {@link Claim} is closed, and this
   * module reads and writes only the fields it declares.
   */
  private async readDocument(): Promise<ClaimDocument> {
    const path = this.claimFilePath;
    const parsed = parse(await readFile(path, "utf8")) as { claims?: unknown };
    const table = parsed.claims;
    if (table === undefined) return { version: CLAIM_VERSION, claims: {} };
    if (typeof table !== "object" || table === null) {
      throw new Error(`${path}: claims is not a table`);
    }

    const claims: Record<string, ClaimRow> = {};
    for (const [sessionId, value] of Object.entries(table)) {
      if (typeof value !== "object" || value === null) {
        throw new Error(`${path}: the claim for ${sessionId} is not a table`);
      }
      const { branch, worktreeName, createdAt } = value as Record<string, unknown>;
      if (typeof branch !== "string" || typeof worktreeName !== "string" || typeof createdAt !== "string") {
        throw new Error(`${path}: the claim for ${sessionId} is missing branch, worktreeName or createdAt`);
      }
      // The key is the identity, so it is put back here rather than stored in the row.
      claims[sessionId] = { branch, worktreeName, createdAt };
    }
    return { version: CLAIM_VERSION, claims };
  }

  /**
   * Write a document back over the whole file.
   *
   * `smol-toml` emits no comments, so the header is prepended by hand, and every
   * write is the entire body: nothing else in the file is worth preserving.
   */
  private async writeDocument(document: ClaimDocument): Promise<void> {
    const body = `${CLAIM_HEADER}${stringify(document)}`;
    // Truncate before writing: the body replaces the file, and a shorter one would
    // otherwise leave the tail of the longer one behind it. The position is
    // explicit, and an `a+` handle — the create case — appends to the empty file
    // the truncate just left.
    await this.handle.truncate(0);
    await this.handle.write(body, 0, "utf8");
  }
}

/**
 * Absolute path of the claim file one context names.
 *
 * The repository comes from the context and the rest of the path from its
 * settings, so this module hardcodes no location: a deployment that moves the
 * claim file moves it for every operation at once.
 *
 * @param context - the settings and the repository's main working tree.
 * @returns the file's path, whose directory the caller creates.
 */
function claimPathOf(context: FlowContext): string {
  return join(context.repoRoot, context.settings.claimFile);
}

/**
 * Open the claim file for reading and writing, creating it when it is absent.
 *
 * `r+` and not `w+`: the file already holds the other families' claims, and
 * truncating it at open would throw away what this store is about to read. The
 * absent case is the only one that creates, and `a+` creates without truncating a
 * file a peer may have created in between.
 *
 * @param path - the claim file, whose directory already exists.
 * @returns the open file.
 */
async function openClaimFile(path: string): Promise<FileHandle> {
  try {
    return await open(path, "r+");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return await open(path, "a+");
  }
}

/**
 * Take the claim file's lock, creating the lock file.
 *
 * **Creating the file is taking the lock**, and `wx` is what makes that mean
 * something: the create succeeds only when the path is free, and the filesystem
 * decides that atomically, so exactly one process can create it. Nothing is
 * waited on — a lock that is held is reported, not queued behind.
 *
 * The one exception is an expired lock. A lock file whose mtime is older than
 * `staleMs` cannot belong to a live critical section, so it is a leftover from a
 * holder that died, and writing this process's own owner line over it is how the
 * leftover is taken over: that write refreshes the mtime, so the touch and the
 * record of who holds the lock are the same one. The window this leaves — two
 * processes touching the same expired lock in the same instant — is in the module
 * doc, recorded rather than papered over.
 *
 * @param lockPath - the lock file's path, whose directory already exists.
 * @param staleMs - how old the lock may be before it is treated as a leftover,
 *   from {@link FlowSettings.lockStaleSeconds}.
 * @throws Error when a live holder has it.
 */
async function acquireLock(lockPath: string, staleMs: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      await handle.close();
      // The owner line is for whoever finds the file and wonders who holds it:
      // nothing reads it, not even this module, so a failed write is not worth
      // failing an acquisition over.
      await writeFile(lockPath, ownerLine()).catch(() => undefined);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const facts = await statOrUndefined(lockPath);
    if (facts === undefined) {
      // The path is free again: a peer released the lock between the create above
      // and this stat, so the create is worth another try.
      if (attempt >= LOCK_CREATE_RETRIES) {
        throw new Error(`the claim lock at ${lockPath} could not be created: it kept being released underneath`);
      }
      continue;
    }

    const ageMs = Date.now() - facts.mtimeMs;
    if (ageMs <= staleMs) {
      throw new Error(
        `the claim lock at ${lockPath} is held by another process (taken ${Math.round(ageMs / 1000)}s ago). ` +
          "Nothing was read and nothing was written; run this again in a moment.",
      );
    }

    await writeFile(lockPath, ownerLine());
    return;
  }
}

/**
 * Release the claim file's lock, removing the lock file.
 *
 * A failure is swallowed. Callers reach this from a `finally`, where an error
 * would replace whatever went wrong first, and a lock file left behind is not a
 * dead end: it goes stale {@link FlowSettings.lockStaleSeconds} later and the next
 * store takes it over.
 *
 * @param lockPath - the lock file's path.
 */
async function releaseLock(lockPath: string): Promise<void> {
  await unlink(lockPath).catch(() => undefined);
}

/**
 * The one line a lock file carries.
 *
 * Debug only, by design: it is written once, when the lock is taken, and nothing
 * in this plugin reads it back. Whoever finds a lock file — a human wondering
 * which session is in the way — is the reader it exists for.
 */
function ownerLine(): string {
  return `pid=${process.pid} at=${new Date().toISOString()}\n`;
}

/**
 * `stat` that answers `undefined` instead of throwing when the path is not there.
 *
 * A lock file that vanished between two calls is a normal state, not an error:
 * that is what a peer releasing the lock looks like from here.
 *
 * @param path - the path to look at.
 * @returns its facts, or `undefined` when it does not exist.
 */
async function statOrUndefined(path: string): Promise<Stats | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}
