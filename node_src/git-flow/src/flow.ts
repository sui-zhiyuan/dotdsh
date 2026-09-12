/**
 * The two workflows, as git operations.
 *
 * This module is harness-free on purpose: it takes already-extracted facts (a
 * session id, an intent string) and a git client, and performs the branch,
 * rebase, merge and worktree work. Everything the harness contributes lives in
 * the command and guard layers that call it.
 *
 * ## `/git-complete` semantics, and why they are these
 *
 * The stated requirement is: merge the feature branch back into the integration
 * branch with `--no-ff`, delete the feature branch, and when the feature is not
 * a direct descendant, rebase it with `--onto` first.
 *
 * "Not a direct descendant" has an exact meaning here, and it is why a plain
 * `git merge` is not enough. A feature branch cut from `master` and left alone is
 * *ahead* of it: `master` is an ancestor of the branch, the merge is a
 * fast-forward candidate, and `--no-ff` turns it into a merge commit that records
 * where the feature began. But once `master` moves — another feature merged,
 * another session's work landed — `master` is no longer an ancestor and the merge
 * base is stale. Merging then produces a merge commit whose second parent holds a
 * history that never sat on top of the first, so the feature's commits appear to
 * have been written against code that did not exist yet. Reviewing, bisecting and
 * reverting all get harder, and `git log --first-parent` starts to lie.
 *
 * So when the merge base is no longer the integration tip, the branch is replayed
 * onto the integration tip first:
 * `git rebase --onto <integration> <merge-base> <branch>`. `--onto` with an
 * explicit upstream is what makes this safe on a branch that may itself have been
 * cut from something other than the integration branch: only
 * `<merge-base>..<branch>` is replayed, and nothing below the branch point is
 * dragged along. A conflict aborts the rebase and reports — it is never resolved
 * automatically, and nothing is ever force-pushed.
 *
 * ## Where each step runs
 *
 * A branch can be checked out in at most one working tree, so "rebase the
 * feature" and "merge into the integration branch" are questions about *which
 * tree*, not only which branch:
 *
 * - the **rebase** runs in the tree that has the feature branch checked out — the
 *   caller's own tree, worktree or not;
 * - the **merge** runs in the tree that has the integration branch checked out.
 *   When nobody has it checked out — the parallel-session case, where every
 *   session sits on its own feature branch — a temporary worktree is created for
 *   the merge and removed again. That keeps one code path for both the
 *   single-session and parallel cases, and means this plugin never repurposes or
 *   hijacks a checkout it does not own.
 *
 * @module @dsh-external/dotdsh-git-flow/flow
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { branchNameFromIntent, hasBranchPrefix, worktreeDirectoryName } from "./branch.js";
import type { Git } from "./exec.js";
import { slugFromCandidate, stripPrefixWord, type IntentNamer } from "./namer.js";
import {
  branchExists,
  commonDir,
  currentBranch,
  defaultIntegrationBranch,
  dropClaim,
  isAncestor,
  isClean,
  localStatePathspec,
  mergeBase,
  otherLiveClaims,
  readLedger,
  repoRoot,
  revParse,
  updateClaim,
  worktreeList,
  worktreeWithBranch,
  type ClaimRegistry,
  type SessionClaim,
  type WorktreeEntry,
} from "./repo.js";

/** The plugin's resolved, fully-defaulted settings. */
export interface FlowConfig {
  /** Branch prefix for features, including the trailing slash. */
  readonly branchPrefix: string;
  /** Integration branch name, or `undefined` to detect it. */
  readonly integrationBranch: string | undefined;
  /** Worktree root, relative to the repository's main working tree. */
  readonly worktreeRoot: string;
  /** Whether a session that arrives while others are live gets a worktree. */
  readonly useWorktreeWhenBusy: boolean;
  /** Whether uncommitted work is committed before a merge rather than blocking it. */
  readonly commitUncommittedBeforeMerge: boolean;
  /** Subject template for the merge commit: `{branch}` and `{integration}` are substituted. */
  readonly mergeMessage: string;
}

/** Everything a flow run needs from its caller. */
export interface FlowDeps {
  /** A git client bound to the calling session's working directory. */
  readonly git: Git;
  /**
   * The workflow's identity: the **root** of the session's delegation chain, not the
   * immediate session. A subagent runs in its parent's working directory, so a branch
   * opened for one of them is opened for all of them — keyed by the immediate session,
   * whichever wrote first would own the record and the other would see a stranger and
   * open a second branch in the same tree, moving it out from under the first.
   */
  readonly sessionId: string;
  /** Whether this session is a delegate (a subagent), rather than one the human opened. */
  readonly isDelegate: boolean;
  /** Owning process id, the fallback when the registry cannot answer liveness. */
  readonly pid: number;
  /** The session registry, asked first about whether another family is still live. */
  readonly registry: ClaimRegistry;
  /** The resolved plugin settings. */
  readonly config: FlowConfig;
  /**
   * The last resort for a branch name, consulted only when the mechanical rules
   * cannot name this session's prompt — see `namer.ts`. Absent means the caller
   * has no namer and the flow asks the human instead.
   */
  readonly namer?: IntentNamer;
  /** Cancellation owned by the caller. */
  readonly signal?: AbortSignal;
}

/** Outcome of `/git-start`. */
export type StartResult =
  | {
      readonly kind: "started";
      readonly branch: string;
      readonly integration: string;
      /** Absolute worktree path when this session got one, else `null`. */
      readonly worktreePath: string | null;
      /** Commit the feature branch starts from. */
      readonly baseCommit: string;
      /** Other live sessions found in this repository. */
      readonly parallelSessions: number;
      /**
       * Branches left by sessions whose process is gone. Their records were
       * dropped, so this is the only report of unmerged work nobody is tracking.
       */
      readonly outstandingBranches: readonly string[];
    }
  | {
      readonly kind: "already-on-feature";
      readonly branch: string;
      readonly worktreePath: string | null;
      readonly integration: string;
    }
  | {
      readonly kind: "need-name";
      readonly integration: string;
      readonly parallelSessions: number;
      readonly reason: string;
    }
  | { readonly kind: "blocked"; readonly reason: string };

/** Outcome of `/git-complete`. */
export type CompleteResult =
  | {
      readonly kind: "merged";
      readonly branch: string;
      readonly integration: string;
      /** Commit the integration branch now points at. */
      readonly mergeCommit: string;
      /** Whether a `rebase --onto` ran first. */
      readonly rebased: boolean;
      /** The merge base the branch was replayed from, when a rebase ran. */
      readonly rebasedFrom: string | undefined;
      /** A commit created to capture uncommitted work, when one was. */
      readonly collectedCommit: string | undefined;
      /** The worktree removed as part of finishing. */
      readonly removedWorktree: string | null;
      /** Whether the feature branch was deleted. */
      readonly deletedBranch: boolean;
      readonly warnings: readonly string[];
    }
  | { readonly kind: "no-changes"; readonly branch: string; readonly integration: string; readonly reason: string }
  | {
      readonly kind: "conflicted";
      readonly branch: string;
      readonly integration: string;
      /** Which step conflicted — the two need different advice. */
      readonly during: "rebase" | "merge";
      readonly files: readonly string[];
    }
  | { readonly kind: "need-branch"; readonly reason: string }
  | { readonly kind: "blocked"; readonly reason: string };

/**
 * Resolve the integration branch from config or from the repository.
 *
 * @param git - any client for the repository.
 * @param config - the resolved settings.
 * @returns the integration branch name.
 */
async function integrationOf(git: Git, config: FlowConfig): Promise<string> {
  if (config.integrationBranch !== undefined && config.integrationBranch !== "") return config.integrationBranch;
  return defaultIntegrationBranch(git);
}

/** Facts about this session's tree that both flows need. */
interface TreeFacts {
  /** Absolute path of this session's working tree. */
  readonly own: string;
  /** Absolute path of the repository's main working tree. */
  readonly mainTree: string;
  /** Whether this session's tree is a linked worktree rather than the main tree. */
  readonly inWorktree: boolean;
  /** Every working tree, as git listed them. */
  readonly trees: readonly WorktreeEntry[];
}

/**
 * Locate this session's tree and the repository's main tree.
 *
 * @param git - a client bound to the session's working directory.
 * @returns the tree facts.
 * @throws GitError when the session's directory is not inside a repository.
 */
async function treeFacts(git: Git): Promise<TreeFacts> {
  const own = await repoRoot(git);
  const trees = await worktreeList(git);
  const mainTree = trees[0]?.path ?? own;
  return { own, mainTree, inWorktree: own !== mainTree, trees };
}

/**
 * Write this family's branch and worktree into its claim.
 *
 * A **patch**, not a whole record: the claim path owns the tree assignment and
 * this only decides the branch and the worktree. Writing the whole record here
 * would erase the assignment, which is what keeps a session that has been given a
 * worktree out of the main tree.
 *
 * @param git - a client for the repository.
 * @param facts - this session's tree facts.
 * @param deps - the flow dependencies.
 * @param branch - the feature branch.
 * @param integration - the integration branch.
 * @param baseCommit - the commit the feature started from.
 * @param worktreePath - the session's worktree, or `null`.
 */
async function record(
  git: Git,
  facts: TreeFacts,
  deps: FlowDeps,
  branch: string,
  integration: string,
  baseCommit: string,
  worktreePath: string | null,
): Promise<void> {
  await updateClaim(git, deps.sessionId, {
    repoKey: await commonDir(git),
    repoRoot: facts.mainTree,
    tree: worktreePath === null ? "main" : "own",
    branch,
    worktreePath,
    integration,
    baseCommit,
    pid: deps.pid,
  });
}


/**
 * Tell whether a path is the same as, or below, another.
 *
 * @param parent - the presumed containing directory.
 * @param child - the path to test.
 * @returns whether `child` is inside `parent`.
 */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Start a feature branch for this session.
 *
 * @param deps - the flow dependencies.
 * @param intent - text describing what the session is working on, or `undefined`.
 * @param explicitName - a branch name given by the human, used verbatim.
 * @returns what happened, including the question to ask when no name can be derived.
 */
export async function startFlow(deps: FlowDeps, intent: string | undefined, explicitName?: string): Promise<StartResult> {
  const { git, config, sessionId, signal } = deps;

  let facts: TreeFacts;
  try {
    facts = await treeFacts(git);
  } catch {
    return { kind: "blocked", reason: "the session's working directory is not inside a git repository" };
  }

  const integration = await integrationOf(git, config);
  const branch = await currentBranch(git);
  if (branch === undefined) {
    return { kind: "blocked", reason: "HEAD is detached; check out a branch before starting a feature" };
  }

  // Already on a usable feature branch. Adopting it is what makes /git-start
  // idempotent, and it is the only sane answer to "start a feature" while one is
  // already open — creating a branch off a branch is never intended. It is also what
  // keeps a subagent from being handed a worktree of its own: it shares its parent's
  // record, so this is *its* branch, not a stranger's.
  //
  // A branch a stranger owns is the exception, and the important one. Two top-level
  // sessions with one working directory are the ordinary way to hit it: the first
  // opens a branch there, so the second no longer sees the integration branch — it
  // sees the first session's branch — and adopting it would put two sessions' work on
  // one branch. That session is isolated instead, by falling through to the worktree
  // path below.
  if (branch !== integration && hasBranchPrefix(branch, config.branchPrefix) && explicitName === undefined) {
    const { others } = await otherLiveClaims(git, sessionId, deps.registry, deps.pid);
    const stranger = others.find((entry) => entry.branch === branch);
    if (stranger === undefined) {
      const existing = (await readLedger(git))[sessionId];
      if (existing === undefined) {
        await record(
          git,
          facts,
          deps,
          branch,
          integration,
          await mergeBase(git, integration, branch),
          facts.inWorktree ? facts.own : null,
        );
      }
      return {
        kind: "already-on-feature",
        branch,
        worktreePath: existing?.worktreePath ?? (facts.inWorktree ? facts.own : null),
        integration,
      };
    }
  } else if (branch !== integration && explicitName === undefined) {
    return {
      kind: "blocked",
      reason:
        `this session is on '${branch}', which is neither the integration branch '${integration}' nor a ` +
        `'${config.branchPrefix}…' branch. Pass a name to branch from here, or check out '${integration}' first.`,
    };
  }

  let name = explicitName ?? (intent === undefined ? undefined : branchNameFromIntent(intent, config.branchPrefix));

  // The mechanical rules cannot name every prompt: they are looking for Latin
  // words, so a prompt in another script yields nothing — or, worse, a lone Latin
  // word it merely mentioned. That is not a reason to give up, because a session
  // that stated its purpose in another language has still stated its purpose. The
  // model reads any language and is already running this session, so it is asked
  // here — after the free, deterministic path, and never before it.
  let namingFailure: string | undefined;
  if (name === undefined && explicitName === undefined && intent !== undefined) {
    if (deps.namer === undefined) {
      namingFailure = "no model-backed namer is installed in this build";
    } else {
      const attempt = await deps.namer(intent, signal).catch((error: unknown) => ({
        kind: "unnamed" as const,
        reason: `the naming call threw: ${error instanceof Error ? error.message : String(error)}`,
      }));
      if (attempt.kind === "named") {
        const slug = slugFromCandidate(attempt.candidate);
        if (slug !== undefined) name = `${config.branchPrefix}${stripPrefixWord(slug, config.branchPrefix)}`;
        else namingFailure = `the answer was not a name: ${JSON.stringify(attempt.candidate.slice(0, 80))}`;
      } else {
        namingFailure = attempt.reason;
      }
    }
  }

  if (name === undefined) {
    // A start that could not name anything changes nothing at all — not a branch,
    // not a worktree, not a claim — so this read deliberately does not persist.
    const { others } = await otherLiveClaims(git, sessionId, deps.registry, deps.pid);
    return {
      kind: "need-name",
      integration,
      parallelSessions: others.length,
      reason:
        intent === undefined
          ? "this session has no usable prompt to name a feature from yet"
          : `the naming rules could not slug this session's prompt (${namingFailure ?? "no namer was tried"})`,
    };
  }

  // Everything below leaves state in this machine's working tree, so the rule that
  // keeps git out of it comes first.
  const { others, outstanding } = await otherLiveClaims(git, sessionId, deps.registry, deps.pid, {
    persist: true,
  });

  const exists = await branchExists(git, name);
  // A delegate normally shares its parent's branch and never reaches here with a name
  // of its own. When it does, it asked explicitly — and letting it switch the shared
  // checkout would silently repoint its parent's work at a different branch, so it
  // gets a worktree even when nobody else is around.
  const wantsOwnCheckout = others.length > 0 || (deps.isDelegate && explicitName !== undefined);
  const useWorktree = config.useWorktreeWhenBusy && wantsOwnCheckout && !facts.inWorktree;
  // The base differs by path: in place, the branch continues from what is checked
  // out; in a worktree, it is cut from the integration branch, because what is
  // checked out belongs to the session being isolated from.
  const baseCommit = useWorktree ? await revParse(git, integration) : await revParse(git, "HEAD");

  if (!useWorktree) {
    // Work in place: either nobody else is in this repository, or this session is
    // already in a worktree of its own.
    await git.text(exists ? ["switch", name] : ["switch", "-c", name], { signal });
    const worktreePath = facts.inWorktree ? facts.own : null;
    await record(git, facts, deps, name, integration, baseCommit, worktreePath);
    return {
      kind: "started",
      branch: name,
      integration,
      worktreePath,
      baseCommit,
      parallelSessions: others.length,
      outstandingBranches: outstanding.map((entry) => entry.branch),
    };
  }

  // A parallel session: isolate in a worktree. The rule ensured above already covers
  // the root, so the worktree is never visible to a `git add --all` even for an
  // instant — there is no window between creating it and protecting it.
  const worktreeRootPath = join(facts.mainTree, config.worktreeRoot);
  const worktreePath = join(worktreeRootPath, worktreeDirectoryName(name, config.branchPrefix));
  if (facts.trees.some((tree) => tree.path === worktreePath)) {
    return {
      kind: "blocked",
      reason:
        `a worktree already exists at ${worktreePath} (another session, or an earlier run of this one). ` +
        "Finish or remove it before starting another feature with the same name.",
    };
  }

  await git.text(exists ? ["worktree", "add", worktreePath, name] : ["worktree", "add", "-b", name, worktreePath, integration], {
    signal,
  });
  await record(git, facts, deps, name, integration, baseCommit, worktreePath);

  return {
    kind: "started",
    branch: name,
    integration,
    worktreePath,
    baseCommit,
    parallelSessions: others.length,
    outstandingBranches: outstanding.map((entry) => entry.branch),
  };
}

/**
 * List the files a rebase or merge left conflicted.
 *
 * @param git - a client bound to the tree that was mid-operation.
 * @returns the unmerged paths, deduplicated.
 */
async function conflictedFiles(git: Git): Promise<readonly string[]> {
  const raw = await git.text(["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
  return [...new Set(raw.split("\n").filter((line) => line !== ""))];
}

/** The two facts finishing a feature needs about it. */
interface BranchToFinish {
  /** The feature branch to merge back. */
  readonly branch: string;
  /** The worktree holding it, when the family has one of its own. */
  readonly worktreePath: string | null;
}

/**
 * Find the branch this session is finishing, adopting a prefixed branch that is
 * checked out but was never claimed.
 *
 * The adoption path matters: a session may be resumed, or the ledger may have
 * been deleted, and refusing to finish a branch that is plainly already a feature
 * branch would strand the work.
 *
 * A claim with no branch is not a candidate — it is a family that has been
 * assigned a tree and has not opened a feature yet, so there is nothing to
 * finish.
 *
 * @param deps - the flow dependencies.
 * @param facts - this session's tree facts.
 * @returns the branch to finish, or `undefined` when there is nothing to finish.
 */
async function resolveRecord(deps: FlowDeps, facts: TreeFacts): Promise<BranchToFinish | undefined> {
  const { git, config, sessionId } = deps;
  const claimed = (await readLedger(git))[sessionId];
  if (claimed !== undefined && claimed.branch !== null) {
    return { branch: claimed.branch, worktreePath: claimed.worktreePath };
  }

  const branch = await currentBranch(git);
  if (branch === undefined || !hasBranchPrefix(branch, config.branchPrefix)) return undefined;

  return { branch, worktreePath: facts.inWorktree ? facts.own : null };
}

/**
 * Finish the session's feature branch: replay it if needed, merge it with
 * `--no-ff`, remove its worktree, and delete it.
 *
 * @param deps - the flow dependencies.
 * @returns what happened, or the precise reason nothing could.
 */
export async function completeFlow(deps: FlowDeps): Promise<CompleteResult> {
  const { git, config, sessionId, signal } = deps;
  const warnings: string[] = [];

  let facts: TreeFacts;
  try {
    facts = await treeFacts(git);
  } catch {
    return { kind: "blocked", reason: "the session's working directory is not inside a git repository" };
  }

  const integration = await integrationOf(git, config);
  // This plugin's own commands must not see — or stage — the local state it keeps in
  // the main tree. There is no ignore rule hiding it (see `localStatePathspec`), so
  // every `git status` and `git add` this file runs says so itself.
  const localState = localStatePathspec(facts.mainTree, config.worktreeRoot);
  const record = await resolveRecord(deps, facts);
  if (record === undefined) {
    return {
      kind: "need-branch",
      reason: `no feature branch is recorded for this session, and no '${config.branchPrefix}…' branch is checked out`,
    };
  }

  const { branch } = record;
  if (branch === integration) {
    return { kind: "blocked", reason: `this session is on '${integration}' itself; there is nothing to complete` };
  }

  // Before anything below writes: the collect step runs `git add --all` in the
  // branch's tree, and this plugin's own ledger sits in the main tree's working
  // directory — absolute local paths and all. It adds no ignore rule, so the command
  // excludes that directory itself (see `localStatePathspec`).
  // The tree holding the feature branch is where the rebase runs.
  const branchTree = (await worktreeWithBranch(git, branch))?.path ?? facts.own;
  const branchGit = git.withCwd(branchTree);

  let collectedCommit: string | undefined;
  if (!(await isClean(branchGit, localState))) {
    if (!config.commitUncommittedBeforeMerge) {
      const status = await branchGit.text(["status", "--short"]);
      return {
        kind: "blocked",
        reason:
          `'${branch}' has uncommitted changes, so it cannot be rebased or merged safely. Commit them first, ` +
          `or enable commitUncommittedBeforeMerge:\n${status}`,
      };
    }
    await branchGit.text(["add", "--all", "--", ".", ...localState], { signal });
    await branchGit.text(["commit", "-q", "-m", `chore(${branch}): collect work in progress`], { signal });
    collectedCommit = await revParse(branchGit, "HEAD");
    warnings.push(
      `uncommitted work was collected into ${collectedCommit.slice(0, 8)} instead of being merged as loose changes`,
    );
  }

  // Nothing ahead of the integration branch: `--no-ff` would report "Already up to
  // date" and create no commit, which would otherwise read as success.
  if ((await branchGit.text(["rev-list", "--count", `${integration}..${branch}`])) === "0") {
    return {
      kind: "no-changes",
      branch,
      integration,
      reason: `'${branch}' has no commits that '${integration}' does not already contain`,
    };
  }

  // Rebase only when the feature is no longer a direct descendant of the
  // integration branch — exactly when the integration tip is no longer the merge
  // base.
  const base = await mergeBase(branchGit, integration, branch);
  const integrationTip = await revParse(branchGit, integration);
  const rebased = base !== integrationTip;
  const rebasedFrom = rebased ? base : undefined;

  if (rebased) {
    const attempt = await branchGit.run(["rebase", "--onto", integration, base, branch], {
      ...(signal === undefined ? {} : { signal }),
    });
    if (attempt.code !== 0) {
      // Collect the unmerged paths BEFORE aborting: `--abort` restores the index
      // and would erase exactly the evidence the report is made of.
      const files = await conflictedFiles(branchGit);
      await branchGit.run(["rebase", "--abort"]).catch(() => undefined);
      if (files.length === 0) {
        return {
          kind: "blocked",
          reason:
            `git rebase --onto reported no conflicting files, so this is not a conflict but a failed replay. ` +
            `The branch is untouched; reproduce with:\n  git rebase --onto ${integration} ${base} ${branch}\n` +
            (attempt.stderr.trim() || "(no stderr)"),
        };
      }
      return { kind: "conflicted", branch, integration, during: "rebase", files };
    }
  }

  const message = config.mergeMessage.replaceAll("{branch}", branch).replaceAll("{integration}", integration);
  const integrationTree = await worktreeWithBranch(git, integration);
  let temporaryRoot: string | undefined;
  let temporaryWorktree: string | undefined;
  let mergeGit: Git;

  if (integrationTree !== undefined) {
    mergeGit = git.withCwd(integrationTree.path);
    if (!(await isClean(mergeGit, localState))) {
      warnings.push(`the tree at ${integrationTree.path} had uncommitted changes while '${integration}' was merged`);
    }
  } else {
    // Nobody has the integration branch checked out, so the merge needs a tree of
    // its own. It goes in the OS temporary directory rather than under the
    // repository's worktree root, for two reasons: it exists for a few seconds and
    // the agent never edits in it, so it does not need to be inside the sandbox
    // the session's file tools are confined to; and keeping it out of the
    // repository means this path never has to write anything into the working tree
    // at `/git-complete` time, and never leaves a linked repository behind where the
    // repository's own tooling would see it if the process dies mid-merge.
    temporaryRoot = await mkdtemp(join(tmpdir(), "dsh-git-flow-merge-"));
    temporaryWorktree = join(temporaryRoot, "tree");
    await git.text(["worktree", "add", temporaryWorktree, integration], { signal });
    mergeGit = git.withCwd(temporaryWorktree);
  }

  try {
    const merge = await mergeGit.run(["merge", "--no-ff", "-m", message, branch], {
      ...(signal === undefined ? {} : { signal }),
    });
    if (merge.code !== 0) {
      const files = await conflictedFiles(mergeGit);
      await mergeGit.run(["merge", "--abort"]).catch(() => undefined);
      if (files.length === 0) {
        return {
          kind: "blocked",
          reason:
            `git merge --no-ff reported no conflicting files, so this is not a conflict but a refused merge ` +
            `(a dirty tree or an unfinished operation). The branch is untouched; reproduce with:\n` +
            `  git -C ${mergeGit.cwd} merge --no-ff ${branch}\n` +
            (merge.stderr.trim() || "(no stderr)"),
        };
      }
      return { kind: "conflicted", branch, integration, during: "rebase", files };
    }
  } finally {
    if (temporaryWorktree !== undefined) {
      await git.run(["worktree", "remove", "--force", temporaryWorktree]).catch(() => undefined);
    }
    if (temporaryRoot !== undefined) {
      await rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  const mergeCommit = await revParse(git, integration);

  // The branch must stop being checked out before it can be deleted: remove the
  // worktree that holds it, or move the plain tree that does back to the
  // integration branch.
  let removedWorktree: string | null = null;
  if (record.worktreePath !== null && record.worktreePath !== branchTree) {
    warnings.push(
      `the recorded worktree ${record.worktreePath} is not the tree holding '${branch}' (${branchTree}); ` +
        "it was left in place",
    );
  } else if (record.worktreePath !== null) {
    if (!(await isClean(branchGit, localState))) {
      return {
        kind: "blocked",
        reason: `worktree ${record.worktreePath} still has uncommitted changes; commit or discard them before finishing`,
      };
    }
    await git.text(["worktree", "remove", record.worktreePath], { signal });
    removedWorktree = record.worktreePath;
  } else if ((await currentBranch(branchGit)) === branch) {
    // The feature was checked out in a plain tree with no worktree of its own, and
    // the integration branch is now free (the temporary merge worktree is gone),
    // so this is the natural place to leave the human: back on the integration
    // branch, where the next /git-start expects to begin.
    await branchGit.text(["switch", integration], { signal });
  }

  let deletedBranch = false;
  if (await branchExists(git, branch)) {
    const remove = await git.run(["branch", "-d", branch], {
      ...(signal === undefined ? {} : { signal }),
    });
    if (remove.code !== 0) warnings.push(`could not delete '${branch}': ${remove.stderr.trim() || "unknown reason"}`);
    else deletedBranch = true;
  }

  await dropClaim(git, sessionId);
  return {
    kind: "merged",
    branch,
    integration,
    mergeCommit,
    rebased,
    rebasedFrom,
    collectedCommit,
    removedWorktree,
    deletedBranch,
    warnings,
  };
}

/**
 * Tell whether the integration branch is an ancestor of a branch.
 *
 * Exposed so the command layer can report whether a `/git-complete` would rebase
 * before the human runs it.
 *
 * @param git - a git client.
 * @param integration - the integration branch.
 * @param branch - the feature branch.
 * @returns whether the feature is a direct descendant of the integration branch.
 */
export function isDirectDescendant(git: Git, integration: string, branch: string): Promise<boolean> {
  return isAncestor(git, integration, branch);
}
