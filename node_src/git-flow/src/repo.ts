/**
 * Repository facts and the durable per-clone ledger of **claims**.
 *
 * A claim is one family's declaration that it is working in one repository, and
 * which working tree it is doing that in. It is the authority for "who may write
 * where": a tree is free when no claim owns it, and the pre-write guard denies a
 * write into a tree another live claim owns. Physical presence confers nothing —
 * a session's working directory never changes, so a session isolated into a
 * worktree still has the main tree as its `cwd` for the rest of its life, and a
 * rule that consulted `cwd` would mark that tree occupied forever.
 *
 * The ledger lives at `<main worktree>/.dsh.local/git-flow.json`, anchored to the
 * main tree because a path resolved from the session's own directory would give
 * every linked worktree its own copy — and the copy a worktree session reads is
 * exactly the one that cannot tell it that another session is already working
 * here. This plugin does not add an ignore rule for it (see the design note); it
 * excludes the directory from its own git commands instead.
 *
 * **Liveness is not ownership.** Which claim is still in force is a separate
 * question from which claim exists, and the answer differs by process: a claim
 * whose session is resident in *this* process is live; a claim that names a
 * session of this process which is no longer resident is dead (that is the case
 * a pid cannot see, because two sessions can share one process); anything else
 * falls back to the pid. The registry is consulted through {@link ClaimRegistry},
 * so this module stays free of the harness packages.
 *
 * @module @dsh-external/dotdsh-git-flow/repo
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Git } from "./exec.js";

/** One checked-out working tree as reported by `git worktree list`. */
export interface WorktreeEntry {
  /** Absolute path of the working tree. */
  readonly path: string;
  /** Commit the working tree is on. */
  readonly head: string;
  /** Short branch name when the working tree is on a branch. */
  readonly branch?: string;
  /** Whether git reports this tree as locked or prunable. */
  readonly prunable?: boolean;
}

/**
 * A branch left behind by a session whose process is gone.
 *
 * The record that tracked it is dropped — nothing can resume it — but the branch
 * and its unmerged commits remain, and silently forgetting them is how work gets
 * lost in a repository. So the branch is reported, once, to whoever opens a
 * feature next.
 */
export interface OutstandingBranch {
  /** The branch the dead session left. */
  readonly branch: string;
  /** The worktree it was working in, when the record named one. */
  readonly worktreePath: string | null;
}

/** Which working tree a family is assigned. */
export type ClaimTree = "main" | "own";

/** What this plugin remembers about one family's working tree. */
export interface SessionClaim {
  /** Harness session id at the root of the family's delegation chain. */
  readonly sessionId: string;
  /** Identity of the repository: its common git directory, shared by all its worktrees. */
  readonly repoKey: string;
  /** Absolute path of the repository's main working tree. */
  readonly repoRoot: string;
  /** The tree this family is assigned: the main tree, or one of its own. */
  readonly tree: ClaimTree;
  /** Absolute path of the family's own worktree, or `null` before one exists. */
  readonly worktreePath: string | null;
  /**
   * The family's feature branch, or `null` when none has been attached yet.
   *
   * Nullable on purpose: a claim is written before any branch exists, which is
   * the honest state for a family that has been assigned a tree and is still
   * standing on the integration branch.
   */
  readonly branch: string | null;
  /** The branch this feature will be merged back into, once one is known. */
  readonly integration: string | null;
  /** Commit the feature branch started from, once one exists. */
  readonly baseCommit: string | null;
  /** Owning process id, used only when the registry cannot answer liveness. */
  readonly pid: number;
  /** ISO timestamp of when the family claimed its tree. */
  readonly claimedAt: string;
}

/**
 * The registry slice liveness needs: whether a session is resident here.
 *
 * Structural rather than imported, so this module — and everything that only
 * needs "is this claim still in force" — stays independent of the harness
 * packages and testable without them. `SessionStore` satisfies it.
 */
export interface ClaimRegistry {
  /**
   * Look up a resident session.
   *
   * @param id - the session id to find.
   * @returns the session, or `undefined` when it is not resident.
   */
  get(id: string): unknown;
}

/** The claim fields a caller may set; everything else is carried over. */
export interface ClaimPatch {
  /** Identity of the repository: its common git directory. */
  readonly repoKey?: string;
  /** The tree the family is assigned. */
  readonly tree?: ClaimTree;
  /** Absolute path of the family's own worktree. */
  readonly worktreePath?: string | null;
  /** The family's feature branch. */
  readonly branch?: string | null;
  /** The branch the feature merges back into. */
  readonly integration?: string | null;
  /** Commit the feature started from. */
  readonly baseCommit?: string | null;
  /** Absolute path of the repository's main working tree. */
  readonly repoRoot?: string;
  /** Owning process id. */
  readonly pid?: number;
  /** ISO timestamp to record, defaulting to now for a new claim. */
  readonly claimedAt?: string;
}

/** The ledger file's shape. */
interface LedgerFile {
  readonly version: 2;
  readonly note: string;
  readonly claims: Record<string, SessionClaim>;
}

const LEDGER_VERSION = 2;

/**
 * What the ledger says about itself, for whoever opens it by hand.
 *
 * This is a field rather than a comment because JSON has none. It is advisory:
 * nothing in the plugin reads it, which is why it does not carry any rule the
 * plugin is relying on someone else to follow.
 */
const LEDGER_NOTE =
  "Machine-local state for the dsh git-flow plugin. It records which session works in which " +
  "working tree, and its paths are absolute paths on this machine. It is not repository content: " +
  "do not commit it, and do not stage it with `git add --all`.";

/**
 * The directory this plugin keeps machine-local state in, and the file it keeps
 * there.
 *
 * `.dsh.local` rather than `.dsh`: the harness already reads `<project>/.dsh/skills`
 * for *project* skills, which are meant to be committed and shared, so a rule
 * ignoring `.dsh/` would quietly stop the team's skills from being tracked. A
 * separate name can be ignored wholesale — one rule covers the worktrees and the
 * ledger both — and the `.local` half says what it is: this machine's, not the
 * repository's.
 *
 * The file is named for its owner rather than `state.json`, because `.dsh.local`
 * is a shared namespace: anything else that keeps local state there can do so
 * without colliding with a name as generic as `state.json`.
 */
export const LOCAL_DIR = ".dsh.local";

/** The ledger file inside {@link LOCAL_DIR}. */
export const LEDGER_FILE = "git-flow.json";

/**
 * Absolute path of the working tree a git client is bound to.
 *
 * @param git - a client bound anywhere inside the repository or a worktree.
 * @returns the absolute top-level working-tree path.
 * @throws GitError when the directory is not inside a repository.
 */
export function repoRoot(git: Git): Promise<string> {
  return git.text(["rev-parse", "--show-toplevel"]);
}

/**
 * Absolute path of the shared git directory, identical for every worktree of one
 * clone. This is the repository's real identity.
 *
 * @param git - a client bound anywhere inside the repository or a worktree.
 * @returns the absolute common git directory.
 */
export async function commonDir(git: Git): Promise<string> {
  const dir = await git.text(["rev-parse", "--git-common-dir"]);
  return resolve(git.cwd, dir);
}

/**
 * Short name of the branch currently checked out in this working tree.
 *
 * @param git - a client bound to a working tree.
 * @returns the branch name, or `undefined` on a detached HEAD.
 */
export async function currentBranch(git: Git): Promise<string | undefined> {
  const name = await git.text(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "");
  return name === "" ? undefined : name;
}

/**
 * Tell whether a local branch exists.
 *
 * @param git - any client for the repository.
 * @param branch - short branch name.
 * @returns whether `refs/heads/<branch>` resolves.
 */
export function branchExists(git: Git, branch: string): Promise<boolean> {
  return git.ok(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/**
 * Pick the branch features are merged back into.
 *
 * Preference order: the branch this clone's `origin/HEAD` points at (the
 * repository's own answer), then a local `main`, then a local `master`. The
 * result is only a default — the plugin's config can name it outright.
 *
 * @param git - any client for the repository.
 * @returns the integration branch name.
 * @throws Error when none of the candidates exists.
 */
export async function defaultIntegrationBranch(git: Git): Promise<string> {
  // A clone with no remote, or one whose origin/HEAD was never set, is the common
  // case for a local repository — and `symbolic-ref` exits non-zero for both. That
  // is not an error here, it just means the repository has no opinion and the
  // local-branch candidates decide.
  const remoteHead = (
    await git.text(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]).catch(() => "")
  ).replace(/^origin\//, "");
  if (remoteHead !== "" && (await branchExists(git, remoteHead))) return remoteHead;

  for (const candidate of ["main", "master"]) {
    if (await branchExists(git, candidate)) return candidate;
  }
  throw new Error("no integration branch found: neither origin/HEAD, main, nor master exists in this repository");
}

/**
 * Tell whether `ancestor` is reachable from `descendant`.
 *
 * @param git - any client for the repository.
 * @param ancestor - the presumed ancestor revision.
 * @param descendant - the presumed descendant revision.
 * @returns whether `ancestor` is an ancestor of (or equal to) `descendant`.
 */
export function isAncestor(git: Git, ancestor: string, descendant: string): Promise<boolean> {
  return git.ok(["merge-base", "--is-ancestor", ancestor, descendant]);
}

/**
 * Best common ancestor of two revisions.
 *
 * @param git - any client for the repository.
 * @param a - first revision.
 * @param b - second revision.
 * @returns the merge base commit id.
 * @throws GitError when the two revisions share no history.
 */
export function mergeBase(git: Git, a: string, b: string): Promise<string> {
  return git.text(["merge-base", a, b]);
}

/**
 * Resolve a revision to a commit id.
 *
 * @param git - any client for the repository.
 * @param rev - revision expression.
 * @returns the resolved commit id.
 */
export function revParse(git: Git, rev: string): Promise<string> {
  return git.text(["rev-parse", "--verify", `${rev}^{commit}`]);
}

/**
 * The pathspec that keeps this plugin's own local state out of its own git commands.
 *
 * This plugin does **not** add an ignore rule for `.dsh.local`; the ruling is that
 * the directory is this machine's business and the model is trusted with the rest.
 * What it does instead is refuse to stage or mis-read its own state: `git add --all`
 * is this plugin's own command, and a ledger of machine-local absolute paths, or a
 * linked worktree staged as a gitlink, must not enter a commit because of it.
 *
 * The paths are relative to the **main** working tree, which is also where the
 * directory is created. Git resolves them against the command's own cwd, so passing
 * them from a linked worktree simply matches nothing — a session in its own worktree
 * has no local-state directory inside it.
 *
 * @param mainTree - absolute path of the repository's main working tree.
 * @param worktreeRoot - the configured worktree root, relative to the main tree.
 * @returns the exclusion pathspecs, each already prefixed with `:!`.
 */
export function localStatePathspec(mainTree: string, worktreeRoot: string): readonly string[] {
  const pathspecs = [`:!${LOCAL_DIR}`];
  const insideLocal = worktreeRoot === LOCAL_DIR || worktreeRoot.startsWith(`${LOCAL_DIR}/`);
  if (!insideLocal && worktreeRoot !== "") pathspecs.push(`:!${worktreeRoot}`);
  return pathspecs;
}

/**
 * Tell whether the working tree has no staged, unstaged, or untracked changes.
 *
 * @param git - a client bound to a working tree.
 * @param exclude - exclusion pathspecs, such as {@link localStatePathspec}'s.
 * @returns whether the tree is clean.
 */
export async function isClean(git: Git, exclude: readonly string[] = []): Promise<boolean> {
  return (await git.text(["status", "--porcelain", "--", ".", ...exclude])) === "";
}

/**
 * Enumerate the repository's working trees.
 *
 * @param git - any client for the repository.
 * @returns one entry per working tree, in git's own order (main tree first).
 */
export async function worktreeList(git: Git): Promise<readonly WorktreeEntry[]> {
  const porcelain = await git.text(["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let path: string | undefined;
  let head = "";
  let branch: string | undefined;
  let prunable = false;

  const flush = (): void => {
    if (path !== undefined) {
      entries.push({ path, head, prunable, ...(branch === undefined ? {} : { branch }) });
    }
    path = undefined;
    head = "";
    branch = undefined;
    prunable = false;
  };

  for (const line of porcelain.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
    else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
  }
  flush();
  return entries;
}

/**
 * Find the working tree that has a given branch checked out.
 *
 * This answers "where may I merge into the integration branch without hijacking
 * someone else's checkout?" — git allows a branch to be checked out in at most
 * one working tree, so at most one entry matches.
 *
 * @param git - any client for the repository.
 * @param branch - short branch name.
 * @returns the matching working tree, or `undefined` when no tree has it checked out.
 */
export async function worktreeWithBranch(git: Git, branch: string): Promise<WorktreeEntry | undefined> {
  const entries = await worktreeList(git);
  return entries.find((entry) => entry.branch === branch);
}

/**
 * Absolute path of the repository's **main** working tree.
 *
 * This is the anchor for everything under {@link LOCAL_DIR}, and it has to be the
 * main tree rather than the caller's own: a path resolved from the session's
 * directory would give every linked worktree its own copy of the state, and the
 * copy a worktree session reads is precisely the one that cannot tell it that it
 * is the second session. Git lists the main working tree first, which is what
 * makes this reliable from anywhere.
 *
 * @param git - any client for the repository.
 * @returns the absolute main working-tree path.
 */
export async function mainWorktree(git: Git): Promise<string> {
  const trees = await worktreeList(git);
  return trees[0]?.path ?? repoRoot(git);
}

/**
 * Absolute path of this plugin's local state directory, anchored to the main tree.
 *
 * @param git - any client for the repository.
 * @returns the absolute `.dsh.local` path.
 */
export function localDir(git: Git): Promise<string> {
  return mainWorktree(git).then((main) => join(main, LOCAL_DIR));
}

/**
 * Absolute path of the session ledger for a repository.
 *
 * @param git - any client for the repository.
 * @returns the ledger file path.
 */
async function ledgerPath(git: Git): Promise<string> {
  return join(await localDir(git), LEDGER_FILE);
}

/**
 * Read the claim ledger.
 *
 * A missing, unreadable, or unrecognized ledger reads as empty: this file is
 * bookkeeping, and losing it may orphan a worktree but must never block a git
 * workflow. There is deliberately no migration from the version-1 shape — that
 * schema recorded a branch instead of a tree assignment, and this plugin has
 * never been published, so a stale file is simply regenerated.
 *
 * @param git - any client for the repository.
 * @returns the recorded claims, keyed by session id.
 */
export async function readLedger(git: Git): Promise<Record<string, SessionClaim>> {
  try {
    const parsed = JSON.parse(await readFile(await ledgerPath(git), "utf8")) as {
      version?: unknown;
      claims?: unknown;
    };
    if (parsed === null || parsed.version !== LEDGER_VERSION) return {};
    if (typeof parsed.claims !== "object" || parsed.claims === null) return {};
    return parsed.claims as Record<string, SessionClaim>;
  } catch {
    return {};
  }
}

/**
 * Replace the claim ledger atomically.
 *
 * @param git - any client for the repository.
 * @param claims - the complete set of claims to persist.
 */
export async function writeLedger(git: Git, claims: Record<string, SessionClaim>): Promise<void> {
  const path = await ledgerPath(git);
  await mkdir(join(path, ".."), { recursive: true });
  const body: LedgerFile = { version: LEDGER_VERSION, note: LEDGER_NOTE, claims };
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/**
 * Read the ledger, apply one patch, write it back.
 *
 * This is the **only** way a claim is written, and the merge is the reason. Two
 * different parts of this plugin decide different fields — the claim path decides
 * the tree, the branch flow decides the branch and the worktree — and either
 * writing the whole record would silently erase the other's decision. A patch
 * carries only what the caller actually determined; everything else is carried
 * over from the ledger.
 *
 * The read-modify-write is not atomic by itself. Callers that can run
 * concurrently with another process hold the ledger's lock around it (see
 * `lock.ts`); callers that run inside a single session's turn cannot.
 *
 * @param git - any client for the repository.
 * @param sessionId - the family's identity.
 * @param patch - the fields this caller determined.
 * @returns the claim as it now stands.
 */
export async function updateClaim(
  git: Git,
  sessionId: string,
  patch: ClaimPatch,
): Promise<SessionClaim> {
  const claims = await readLedger(git);
  const existing = claims[sessionId];
  const defined = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
  const merged: SessionClaim = {
    // A claim that has never been written starts from what the patch implies:
    // a family with a worktree of its own is not in the main tree.
    sessionId,
    repoKey: existing?.repoKey ?? "",
    repoRoot: existing?.repoRoot ?? "",
    tree: existing?.tree ?? (patch.worktreePath ? "own" : "main"),
    worktreePath: existing?.worktreePath ?? null,
    branch: existing?.branch ?? null,
    integration: existing?.integration ?? null,
    baseCommit: existing?.baseCommit ?? null,
    pid: existing?.pid ?? 0,
    claimedAt: existing?.claimedAt ?? new Date().toISOString(),
    ...defined,
  };
  claims[sessionId] = merged;
  await writeLedger(git, claims);
  return merged;
}

/**
 * Drop this session's claim.
 *
 * @param git - any client for the repository.
 * @param sessionId - the family to forget.
 */
export async function dropClaim(git: Git, sessionId: string): Promise<void> {
  const claims = await readLedger(git);
  if (delete claims[sessionId]) await writeLedger(git, claims);
}

/**
 * Tell whether a process id is still running.
 *
 * `process.kill(pid, 0)` performs the existence and permission check without
 * delivering a signal; `EPERM` means the process exists but belongs to another
 * user, which still counts as alive.
 *
 * @param pid - the process id to test.
 * @returns whether a process with that id exists.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Tell whether a claim is still in force.
 *
 * Ownership and liveness are different questions, and the pid alone answers
 * neither well. Three cases, in order:
 *
 * - the session is **resident here** — it is live, whatever the pid says;
 * - the claim names a session **of this process** that is not resident — it is
 *   dead. This is the case a pid can never see: several sessions share one
 *   harness process, so a closed session's claim keeps a pid that is very much
 *   alive, and a later session is handed a worktree it did not need;
 * - anything else — the claim belongs to **another process**, and the pid is the
 *   only signal there is. It is wrong across a restart in both directions, which
 *   is why the registry is asked first (see `doc/src/todo.md`).
 *
 * @param claim - the claim to test.
 * @param registry - the session registry, for the resident-session case.
 * @param ownPid - the calling process's id.
 * @returns whether the claim still counts as a competitor.
 */
export function isClaimLive(claim: SessionClaim, registry: ClaimRegistry, ownPid: number): boolean {
  if (claim.sessionId !== "" && registry.get(claim.sessionId) !== undefined) return true;
  if (claim.pid === ownPid) return false;
  return isProcessAlive(claim.pid);
}

/**
 * Find the other live claims on the same repository.
 *
 * Dead claims are reported here rather than left to make a later run believe the
 * repository is busy. The ledger is rewritten **only** when `persist` is set:
 * pruning is owned by the commands that were asked to change something and by
 * `/git-cleanup`. The pre-write guard calls this on every file-mutating tool call
 * and writes only its own claim there, because a gate that swept other sessions'
 * records would be rewriting state it did not decide, on the hot path.
 *
 * @param git - any client for the repository.
 * @param ownSessionId - the calling family, excluded from the result.
 * @param registry - the session registry, for liveness.
 * @param ownPid - the calling process's id.
 * @param options - `persist` writes the pruned ledger; the default only reports.
 * @returns the other live claims, whatever dead claims still hold, and the repo key.
 */
export async function otherLiveClaims(
  git: Git,
  ownSessionId: string,
  registry: ClaimRegistry,
  ownPid: number,
  options: { readonly persist?: boolean } = {},
): Promise<{
  readonly others: readonly SessionClaim[];
  readonly repoKey: string;
  readonly outstanding: readonly OutstandingBranch[];
}> {
  const repoKey = await commonDir(git);
  const claims = await readLedger(git);
  const others: SessionClaim[] = [];
  const outstanding: OutstandingBranch[] = [];
  let pruned = false;
  const kept: Record<string, SessionClaim> = {};

  for (const [id, claim] of Object.entries(claims)) {
    if (isClaimLive(claim, registry, ownPid)) {
      kept[id] = claim;
      if (id !== ownSessionId && claim.repoKey === repoKey) others.push(claim);
      continue;
    }

    // The claim cannot be resumed, so it is dropped — but only once its branch is
    // gone too. A branch that still exists is unmerged work, and this is the last
    // moment the ledger knows it was ever opened.
    if (claim.repoKey === repoKey && claim.branch !== null && (await branchExists(git, claim.branch))) {
      outstanding.push({ branch: claim.branch, worktreePath: claim.worktreePath });
    }
    pruned = true;
  }

  if (pruned && options.persist === true) await writeLedger(git, kept);
  return { others, repoKey, outstanding };
}
