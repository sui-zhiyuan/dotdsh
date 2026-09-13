/**
 * The claim file: which branch and which worktree each session family owns.
 *
 * A claim is the durable answer to "which working tree does this session write
 * in". The file belongs to the repository but is not repository content: it names
 * absolute machine-local paths, so it must stay out of every commit — see below.
 *
 * ## One instance, one lock
 *
 * **The lock is not implemented yet.** A store holds the claim file open for its
 * whole lifetime, and every write goes through that descriptor, but
 * {@link ClaimStore.open} takes no lock and {@link ClaimStore.dispose} releases
 * none. That leaves exactly the hole the lock is for: two processes can interleave
 * a read and a write, so one of them writes a document it read before the other's
 * change landed, and a claim is lost with nothing reporting it. No lock file
 * stands in for it in the meantime.
 *
 * TODO: take the exclusive lock in {@link ClaimStore.open} — waiting on the event
 * loop for a peer's lock, up to {@link LOCK_TIMEOUT_MS}, never blocking and never
 * failing on sight — and release it in {@link ClaimStore.dispose}. With the lock
 * in hand, mutating the file through one open descriptor is what makes "read the
 * claim, then change it" a single critical section instead of two operations
 * another process can interleave, and it is why no separate lock file is needed,
 * with its own stale-lock deadlock.
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
 * branch = "feature/git-flow-rewrite"
 * worktreeName = "session-ea4ebc37"
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

import { mkdir, open, readFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, stringify } from "smol-toml";

/**
 * The claim file, relative to the repository's main working tree.
 *
 * Hardcoded for now. Its directory must appear in `.gitignore` — this module
 * never stages it, but nothing else knows to exclude it either.
 */
const CLAIM_FILE = ".dsh.local/git-flow.toml";

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

/**
 * How long {@link ClaimStore.open} will wait for a peer's lock before giving up.
 *
 * Unused for now: it is the bound the lock reaches for once {@link ClaimStore.open}
 * actually takes one. Hardcoded, like every other path and bound in this rewrite.
 * It only has to outlast a peer's claim write, which is a read-modify-write of one
 * small file; anything longer than this is a peer that is not coming back, and
 * waiting for it would be the deadlock this design exists to avoid.
 */
const LOCK_TIMEOUT_MS = 2000;

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
 * The claim file, held open.
 *
 * One instance per repository, and one operation at a time through it. The lock
 * that would make "one at a time" true across processes is **not implemented
 * yet** — see the module doc — so today the serialization is only this instance's.
 * A store that outlives its usefulness is worse than no store at all, because the
 * handle — and, once it lands, the lock — lives as long as the instance does, so
 * `dispose` belongs in a `finally`.
 */
export class ClaimStore {
  /** Absolute path of the repository's main working tree; every path this store uses derives from it. */
  readonly repoRoot: string;
  /**
   * The open file every write goes through, and the descriptor the exclusive lock
   * will ride on once it lands.
   */
  private readonly handle: FileHandle;

  /**
   * Build a store around an already-open file.
   *
   * Private, and it stays that way: {@link ClaimStore.open} is the only way to an
   * instance, because the handle has to be in hand before any method is called —
   * and, once the lock exists, the lock has to be as well.
   */
  private constructor(repoRoot: string, handle: FileHandle) {
    this.repoRoot = repoRoot;
    this.handle = handle;
  }

  /**
   * Open the repository's claim file.
   *
   * Creates the file and its directory when they are not there yet, then reads the
   * file once, so one that cannot be read or parsed fails here rather than at the
   * first command a session runs.
   *
   * **It does not take the lock yet** (see the module doc). Once it does, a lock
   * held by another process is waited for on the event loop, up to
   * {@link LOCK_TIMEOUT_MS}; once that passes, this throws rather than waiting
   * forever, and the caller decides whether the family may proceed without a
   * claim.
   *
   * @param repoRoot - absolute path of the repository's main working tree.
   * @returns an open store, which the caller must {@link ClaimStore.dispose}.
   */
  static async open(repoRoot: string): Promise<ClaimStore> {
    const path = claimPath(repoRoot);
    await mkdir(dirname(path), { recursive: true });
    const handle = await openClaimFile(path);
    const store = new ClaimStore(repoRoot, handle);
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
  }

  /**
   * Close the file — and release the lock, once there is one.
   *
   * The destructor of this class: everything else in it is only valid before this
   * runs. Safe to call once; calling it twice is a caller bug.
   */
  dispose(): Promise<void> {
    return this.handle.close();
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
    const path = claimPath(this.repoRoot);
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
 * Absolute path of the claim file inside one repository.
 *
 * @param repoRoot - absolute path of the repository's main working tree.
 * @returns the file's path, whose directory the caller creates.
 */
function claimPath(repoRoot: string): string {
  return join(repoRoot, CLAIM_FILE);
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
