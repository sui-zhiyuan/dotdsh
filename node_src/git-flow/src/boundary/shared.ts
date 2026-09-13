/**
 * What the entry points share: who a session is, what an entry point runs with,
 * and what counts as a legal argument.
 *
 * `commands` and `tools` are two doors into the same three operations — one for a
 * human typing, one for a model calling — and the few things they have to agree on
 * live here rather than in each of them. Nothing below this file uses it: `core`
 * neither knows nor asks who its caller was.
 *
 * Talking to the harness is *not* shared. Each door adapts its own
 * `CommandInvocation` or `ToolRunContext` into the view below, so the shape dsh
 * hands over stays inside the file that receives it, and this module only ever
 * sees {@link SessionAgent} and plain values.
 *
 * The rule for what belongs here is the one in that sentence: a function earns
 * its place only when *both* doors call it. Something one door needs and the other
 * does not — the sweep scope is the current example — is exported, but it is not
 * folded into anyone else's inputs.
 *
 * ## Why the argument checks are here, and only here
 *
 * `core` trusts what it is handed. It runs git in the tree it was told to, on the
 * branch name it was given, and a second check inside it would be a second answer
 * to a question that already has one. The boundary is where text a human typed or
 * a model generated enters the plugin, so it is checked there — once, by the
 * command door and the tool door alike, before either of them calls `core`.
 *
 * ## Why the session walk is here
 *
 * A family is keyed by the topmost session of a delegation chain, and following
 * the chain needs the resident session store. The entry points have it; `core`
 * does not, and must not. See {@link familyRoot}.
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` and `platform` are both fair game — and
 * never upward: nothing below this layer may import it.
 *
 * @module @dsh-external/dotdsh-git-flow/shared
 */

import type { Runner } from "../platform/exec.js";

/** One resident session, as much of it as these helpers read. */
export interface SessionRecord {
  /** The durable session id. */
  readonly id: string;
  /** The session's immutable creation metadata. */
  readonly header: {
    /** Absolute working directory of the session; absent when it has none. */
    readonly cwd?: string | undefined;
    /**
     * The session this one was delegated or forked from.
     *
     * Present exactly when this session is not one a human opened, which is what
     * makes it the whole of the top-level test.
     */
    readonly parentSession?: string | undefined;
  };
}

/**
 * The slice of the harness session store these helpers read.
 *
 * {@link SessionAgent.getSessions} resolves it, and the harness's own session
 * store satisfies it. Kept structural so this module stays free of the harness
 * packages, exactly like the entry points that import it.
 */
export interface SessionRegistry {
  /**
   * Look up a resident session.
   *
   * @param id - the session id to find.
   * @returns the session, or `undefined` when it is not resident.
   */
  get(id: string): SessionRecord | undefined;
  /**
   * Every resident session.
   *
   * @returns the sessions this process currently holds.
   */
  list(): readonly SessionRecord[];
}

/** The calling agent, as this plugin uses it. */
export interface SessionAgent {
  /** The agent's own session. */
  readonly session: SessionRecord;
  /**
   * The process seam every git call goes through.
   *
   * A getter, not a field: the service behind it belongs to the running process,
   * and nothing in this plugin should hold a reference to it. The return type is
   * this plugin's own {@link Runner}, not the harness service — only the methods
   * this plugin calls are named at all.
   */
  getRunner(): Runner;
  /**
   * The resident session store.
   *
   * The two things that need it are the delegation walk and the sweep scope, so
   * that is the whole of the interface it is narrowed to.
   */
  getSessions(): SessionRegistry;
}

/** Everything an entry point needs before it can call `core`. */
export interface EntryFacts {
  /** The process seam every git call goes through. */
  readonly runner: Runner;
  /** Absolute path of the repository's **main** working tree. */
  readonly repoRoot: string;
  /** Root of the calling session's delegation chain: the family's key. */
  readonly sessionId: string;
}

/** Prefix every branch this plugin opens carries. Hardcoded for now. */
const BRANCH_PREFIX = "feat/";

/**
 * The topmost session of a delegation chain — the identity every decision in
 * this plugin is keyed by.
 *
 * A family shares one checkout: a subagent runs in its parent's working
 * directory, so a branch opened for one of them is opened for all of them. Keyed
 * by the immediate session, whichever of the two wrote first would own the
 * record, and the other would then see a stranger and open a *second* branch in
 * the same tree — moving it out from under the first. Keyed by the root, they
 * share one record and one branch whoever writes first, which is also what keeps
 * a subagent from being handed a worktree of its own.
 *
 * The walk stops at the first ancestor that is no longer resident, so a chain
 * whose middle has been disposed resolves to the highest ancestor still reachable
 * rather than failing: a coarser identity, not a wrong one. A `seen` set makes a
 * cycle terminate instead of hanging.
 *
 * @param sessionId - the calling session's id.
 * @param sessions - the resident session store, used to follow the chain upwards.
 * @returns the id of the topmost ancestor, or `sessionId` when it is top-level.
 */
function familyRoot(sessionId: string, sessions: SessionRegistry): string {
  throw new Error("familyRoot is not implemented");
}

/**
 * The sessions a sweep must leave alone.
 *
 * Every resident session a human opened — the top-level ones, which is to say the
 * ones with no `parentSession`, since a subagent's family is the top-level
 * session's family. The exact condition is still open; this is the working
 * definition, and it is deliberately conservative: a claim that survives a sweep
 * costs a stale record, while one swept too early costs a live session its
 * worktree.
 *
 * @param sessions - the resident session store.
 * @returns the ids whose claims are off limits.
 */
export function resumableSessionIds(sessions: SessionRegistry): readonly string[] {
  throw new Error("resumableSessionIds is not implemented");
}

/**
 * Build this plugin's view of the agent dsh handed over.
 *
 * The one adaptation from the harness's shape to this plugin's, and the reason
 * the view exists at all: dsh types an agent as `{ id }` and resolves every
 * service through a context, while everything calling the helpers below wants a
 * session, a runner and the resident session store. Every door calls this, and no
 * door repeats it — which is also the only place in this package that names a
 * service by string.
 *
 * @param agent - the agent from an invocation, a tool execution or an
 *   interception, as dsh typed it. Deliberately `unknown`: the harness's own type
 *   for it says nothing this function needs.
 * @returns the view the shared helpers take.
 */
export function sessionAgentOf(agent: unknown): SessionAgent {
  throw new Error("sessionAgentOf is not implemented");
}

/**
 * Read the session facts one entry point runs with.
 *
 * Everything the boundary needs about this run, gathered once instead of being
 * spelled out in every handler. Four facts, from four different places:
 *
 * - the **family key** is the topmost session of the chain, not the calling
 *   session;
 * - the **repository** is the main working tree, not the session's cwd: a session
 *   already isolated in a worktree has a cwd inside it, while the claim file lives
 *   in the main tree;
 * - the **runner** is the process seam, asked of the agent itself so that nothing
 *   has to pass one down;
 * - the **sweep scope** is every session that can still be resumed, which only
 *   the cleanup door reads but which is asked for here, because nothing above
 *   this file should have to walk the session store.
 *
 * @param agent - the calling agent, asked for its session and the two services.
 * @returns everything the caller needs before calling `core`.
 */
export function factsFor(agent: SessionAgent): Promise<EntryFacts> {
  throw new Error("factsFor is not implemented");
}

/**
 * Normalize a branch name the way this plugin writes it.
 *
 * A name that already carries the prefix is left alone; any other name gets it,
 * so a name typed by a human, generated by a model, and derived from a worktree
 * all end up with the same shape — which is what lets a later operation
 * recognize a branch as this plugin's.
 *
 * @param name - the raw name, with or without a prefix.
 * @returns the name to create.
 */
export function withBranchPrefix(name: string): string {
  throw new Error("withBranchPrefix is not implemented");
}

/**
 * The directory name a family's worktree takes.
 *
 * Derived from the branch, so the two can never disagree about which feature this
 * is, with `-` written as `_`. The rule is one line, and it lives here rather
 * than in either door because both of them open worktrees and the two names have
 * to be the same one.
 *
 * @param branch - the branch name, already prefixed.
 * @returns the worktree's directory name, under the repository's worktree root.
 */
export function worktreeNameFor(branch: string): string {
  throw new Error("worktreeNameFor is not implemented");
}

/**
 * Whether git itself accepts this as a branch name.
 *
 * `check-ref-format --branch` is git's own validator, so anything git would
 * refuse is refused here rather than at the moment a branch is created, and the
 * caller can say so while it still has the human's or the model's attention.
 *
 * @param runner - the process seam.
 * @param repoRoot - absolute path of the repository's main working tree.
 * @param name - the branch name to check, already prefixed.
 * @returns whether the name is legal.
 */
export async function isValidBranchName(runner: Runner, repoRoot: string, name: string): Promise<boolean> {
  throw new Error("isValidBranchName is not implemented");
}
