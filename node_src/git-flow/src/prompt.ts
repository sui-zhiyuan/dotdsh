/**
 * The "global information" the workflow needs the model to hold.
 *
 * One contribution: a **section** carrying the contract — work on a feature branch,
 * commit after each step, use the commit skill, do not merge by hand, never
 * force-push. It is static, so it is recomputed identically at every assembly and
 * only persisted when the prompt header changes.
 *
 * There is deliberately **no state context** describing the current branch or
 * worktree. An earlier version had one, kept fresh by a per-session cache in
 * `state.ts`, and it was removed for three reasons:
 *
 * - **The enforcement never needed it.** Whether a write is allowed is decided by the
 *   guard, by running git — not by reading the prompt. A model told the wrong branch
 *   writes exactly as it would have otherwise; a model told the right one is not
 *   thereby stopped from writing anywhere.
 * - **Its useful half already arrives at the right moment.** A session isolated into a
 *   worktree learns that from the guard's refusal, which names the worktree and the
 *   exact file to write instead of the one it aimed at — just in time, and never
 *   stale. Nothing in the contract below depends on where the session currently is.
 * - **A cached branch can lie.** It changes when a human switches branches by hand, so
 *   an injected line can contradict reality in the transcript, and a model may act on
 *   the contradiction. A model that wants to know can run `git branch --show-current`
 *   and be right.
 *
 * @module @dsh-external/dotdsh-git-flow/prompt
 */

import type { Context } from "@deepseek-ai/cordis";

/**
 * Order of the workflow section.
 *
 * Placed after the plan/team policy sections and well before the tool schemas, so
 * the contract is read as operating policy rather than as tool documentation.
 */
const SECTION_ORDER = 550;

/** The name of the section, unique in the registry. */
const SECTION_NAME = "git-flow:workflow";

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
 * Register the workflow section.
 *
 * @param ctx - the plugin context, with `systemPrompt` injected.
 * @returns a disposer that removes the contribution.
 */
export function registerPrompt(ctx: Context): () => void {
  return ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: WORKFLOW,
  });
}
