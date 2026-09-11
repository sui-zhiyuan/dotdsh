/**
 * Repository facts and the durable per-clone session ledger.
 *
 * Everything here is either a read of git's own state or the bookkeeping this
 * plugin keeps about which session owns which feature branch. The bookkeeping
 * lives in the repository's **common** git directory
 * (`<git-common-dir>/dsh-git-flow/`), deliberately not in the working tree:
 *
 * - it is per-clone, which is the right scope for machine-local worktree paths;
 * - it is never staged, so it can never be swept into a commit by this plugin's
 *   own per-step commits or by another session's `git add --all`;
 * - it needs no `.gitignore` entry of its own, so the ignore guard has exactly
 *   one thing to protect — the worktree root — and stays explainable.
 *
 * Sessions are identified by the harness session id, not by process id: several
 * sessions can share one harness process, so a pid cannot tell two of them
 * apart. The pid is recorded only to let a later run prune records whose process
 * has died.
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

/** What this plugin remembers about one session's feature branch. */
export interface SessionRecord {
  /** Harness session id that owns this branch. */
  readonly sessionId: string;
  /** Identity of the repository: its common git directory, shared by all its worktrees. */
  readonly repoKey: string;
  /** Absolute path of the repository's main working tree. */
  readonly repoRoot: string;
  /** The feature branch the session works on. */
  readonly branch: string;
  /** Absolute path of the session's worktree, or `null` when it works in the main tree. */
  readonly worktreePath: string | null;
  /** The branch this feature will be merged back into. */
  readonly integration: string;
  /** Commit the feature branch started from. */
  readonly baseCommit: string;
  /** Owning process id, used only to detect records whose process is gone. */
  readonly pid: number;
  /** ISO timestamp of when the branch was started. */
  readonly startedAt: string;
}

interface LedgerFile {
  readonly version: 1;
  readonly sessions: Record<string, SessionRecord>;
}

const LEDGER_VERSION = 1;

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
 * Tell whether the working tree has no staged, unstaged, or untracked changes.
 *
 * @param git - a client bound to a working tree.
 * @returns whether the tree is clean.
 */
export async function isClean(git: Git): Promise<boolean> {
  return (await git.text(["status", "--porcelain"])) === "";
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
 * Read the session ledger.
 *
 * A missing or unreadable ledger reads as empty: this file is bookkeeping, and
 * losing it may orphan a worktree but must never block a git workflow.
 *
 * @param git - any client for the repository.
 * @returns the recorded sessions, keyed by session id.
 */
export async function readLedger(git: Git): Promise<Record<string, SessionRecord>> {
  try {
    const parsed = JSON.parse(await readFile(await ledgerPath(git), "utf8")) as LedgerFile;
    if (parsed.version !== LEDGER_VERSION || typeof parsed.sessions !== "object" || parsed.sessions === null) {
      return {};
    }
    return parsed.sessions;
  } catch {
    return {};
  }
}

/**
 * Replace the session ledger atomically.
 *
 * @param git - any client for the repository.
 * @param sessions - the complete set of records to persist.
 */
export async function writeLedger(git: Git, sessions: Record<string, SessionRecord>): Promise<void> {
  const path = await ledgerPath(git);
  await mkdir(join(path, ".."), { recursive: true });
  const body: LedgerFile = { version: LEDGER_VERSION, sessions };
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

/**
 * Record this session's feature branch, replacing any earlier record for it.
 *
 * @param git - any client for the repository.
 * @param record - the record to store.
 */
export async function rememberSession(git: Git, record: SessionRecord): Promise<void> {
  const sessions = await readLedger(git);
  sessions[record.sessionId] = record;
  await writeLedger(git, sessions);
}

/**
 * Drop this session's record.
 *
 * @param git - any client for the repository.
 * @param sessionId - the session to forget.
 */
export async function forgetSession(git: Git, sessionId: string): Promise<void> {
  const sessions = await readLedger(git);
  if (delete sessions[sessionId]) await writeLedger(git, sessions);
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
 * Find other live sessions working in the same repository.
 *
 * Records whose process is gone are pruned here rather than left to make a later
 * run believe the repository is busy.
 *
 * The ledger is only rewritten when `persist` is set. Pruning is therefore owned
 * by the two commands that were asked to change something, not by the pre-write
 * guard — which calls this on every file-mutating tool call, and which must not
 * write state at all: a gate that rewrites the ledger would have to make sure the
 * ledger is ignored first, on the hot path, to stay safe.
 *
 * @param git - any client for the repository.
 * @param ownSessionId - the calling session, excluded from the result.
 * @param options - `persist` writes the pruned ledger; the default only reports.
 * @returns the other live records, whatever dead records still hold, and the repo key.
 */
export async function otherLiveSessions(
  git: Git,
  ownSessionId: string,
  options: { readonly persist?: boolean } = {},
): Promise<{
  readonly others: readonly SessionRecord[];
  readonly repoKey: string;
  readonly outstanding: readonly OutstandingBranch[];
}> {
  const repoKey = await commonDir(git);
  const sessions = await readLedger(git);
  const others: SessionRecord[] = [];
  const outstanding: OutstandingBranch[] = [];
  let pruned = false;
  const kept: Record<string, SessionRecord> = {};

  for (const [id, record] of Object.entries(sessions)) {
    if (isProcessAlive(record.pid)) {
      kept[id] = record;
      if (id !== ownSessionId && record.repoKey === repoKey) others.push(record);
      continue;
    }

    // The process is gone. The record cannot be resumed, so it is dropped — but
    // only once its branch is gone too. A branch that still exists is unmerged
    // work, and this is the last moment the ledger knows it was ever opened.
    if (record.repoKey === repoKey && (await branchExists(git, record.branch))) {
      outstanding.push({ branch: record.branch, worktreePath: record.worktreePath });
    }
    pruned = true;
  }

  if (pruned && options.persist === true) await writeLedger(git, kept);
  return { others, repoKey, outstanding };
}
