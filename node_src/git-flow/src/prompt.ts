/**
 * The "global information" the workflow needs the model to hold.
 *
 * Two contributions, deliberately split by how durable each one is:
 *
 * - a **section** carries the contract — work on a feature branch, commit after
 *   each step, use the commit skill, do not merge by hand. It is static, so it is
 *   recomputed identically at every assembly and only persisted when the prompt
 *   header changes.
 * - a **context** carries the state — which branch this session is on, and where
 *   its worktree is. The harness projects a context contribution into a
 *   plugin-sourced user-role message appended to the conversation, so it is
 *   durable and re-emitted only when its text changes.
 *
 * The context's text provider is synchronous by contract, which is why it reads
 * {@link GitFlowState} rather than asking git: see that module for what may be
 * one step stale and why that is acceptable.
 *
 * @module @dsh-external/dotdsh-git-flow/prompt
 */

import type { Context } from "@deepseek-ai/cordis";
import type { SessionSnapshot } from "./state.js";
import { sessionRoot, type AgentLike, type SessionRegistryLike } from "./session.js";

/**
 * Order of the workflow section.
 *
 * Placed after the plan/team policy sections and well before the tool schemas, so
 * the contract is read as operating policy rather than as tool documentation.
 */
const SECTION_ORDER = 550;

/**
 * Order of the state context.
 *
 * Placed just after the sandbox and approval policy contexts, so the last thing
 * the model reads before acting is where it is actually standing.
 */
const CONTEXT_ORDER = 125;

/** The name of the section, unique in the registry. */
const SECTION_NAME = "git-flow:workflow";

/** The name of the context, unique in the registry. */
const CONTEXT_NAME = "git-flow:state";

const WORKFLOW = `## Git workflow

This session works on a feature branch. The integration branch is never edited
directly.

- \`/git-start\` opens the feature branch. If a file is modified while the
  integration branch is checked out, the branch is opened for you before the write
  proceeds — that is intended, so do not undo it and do not create branches by
  hand.
- **Commit after each completed step**, not once at the end. A step is a change
  that stands on its own. Work left uncommitted is work that can be lost, and a
  commit is the checkpoint that makes a wrong step cheap to undo.
- Follow the \`${"git-commit"}\` skill when writing commit messages.
- \`/git-complete\` replays the branch if the integration branch has moved, merges
  it with a merge commit, and deletes it. Do not merge, rebase, or delete branches
  by hand.
- Never force-push, never rewrite published history, and never commit directly to
  the integration branch.`;

/**
 * Render the state context for one session.
 *
 * @param snapshot - the session's last known position, when one has been taken.
 * @returns the context text, or an empty string when there is nothing to say.
 */
export function renderState(snapshot: SessionSnapshot | undefined): string {
  if (snapshot === undefined) return "";
  if (snapshot.repoRoot === undefined) return "";
  if (snapshot.branch === undefined) {
    return `git-flow: HEAD is detached in ${snapshot.repoRoot}. Check out a branch before committing.`;
  }

  const position = `git-flow: this session is on \`${snapshot.branch}\`` +
    (snapshot.integration === undefined ? "" : ` (integration branch \`${snapshot.integration}\`)`) + ".";

  if (snapshot.worktreePath !== null) {
    return (
      `${position} Another session is working in the main tree, so this session has its own worktree at ` +
      `\`${snapshot.worktreePath}\`. Make every file edit there, using absolute paths — editing elsewhere in ` +
      `the repository would collide with that session.`
    );
  }

  if (snapshot.tree === "own") {
    // The claim is decided before the tree exists, so this is the state a session is
    // in from its first write attempt until `/git-start` names the branch: saying
    // "you are on the integration branch, an edit will open a branch first" would be
    // false, because an edit here is refused — the main tree belongs to someone else.
    return (
      `${position} Another session owns the main tree, so this session will work in a worktree of its own. ` +
      "Run `/git-start` to name its branch (or `/git-start <name>`), then make every edit there."
    );
  }

  if (snapshot.onIntegration) {
    return (
      `${position} This is the integration branch, so a file edit will open a feature branch first. ` +
      `Run \`/git-start\` to choose its name deliberately.`
    );
  }

  return position;
}

/**
 * Register the workflow section and the state context.
 *
 * @param ctx - the plugin context, with `systemPrompt` and `sessions` injected.
 * @param snapshotOf - reads the last snapshot for a workflow identity.
 * @returns a disposer that removes both contributions.
 */
export function registerPrompt(
  ctx: Context,
  snapshotOf: (identity: string) => SessionSnapshot | undefined,
): () => void {
  const disposeSection = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: WORKFLOW,
  });

  const disposeContext = ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (assembly) => {
      const agent = assembly.agent;
      if (agent === undefined) return "";
      // The registry read is synchronous, so the provider stays synchronous while
      // still resolving the same identity the rest of the plugin uses.
      return renderState(snapshotOf(sessionRoot(agent, ctx.sessions as SessionRegistryLike)));
    },
  });

  return () => {
    disposeContext();
    disposeSection();
  };
}
