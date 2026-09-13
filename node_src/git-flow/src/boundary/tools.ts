/**
 * The tools: the same three operations as the commands, for the model to call.
 *
 * One export — {@link GIT_FLOW_TOOLS}. A wiring module iterates it and registers
 * each entry with the harness:
 *
 * ```ts
 * for (const tool of GIT_FLOW_TOOLS) {
 *   ctx.effect(() => ctx.tools.register(defineTool({ ...tool.descriptor, output, execute: tool.execute })));
 * }
 * ```
 *
 * ## How a tool differs from the command that does the same thing
 *
 * - **The model supplies the judgement, and must.** A command may be run bare and
 *   answer with a question; a tool call arrives with its arguments already filled.
 *   The branch name and the merge message are therefore *required*: a call without
 *   them is rejected before this file runs, and a model that does not know the
 *   name must ask the human and call again. That is the whole reason the tool
 *   forms exist — a tool has no conversation to fall back on.
 * - **Nothing is injected.** A command injects context because the model is the one
 *   who will fill the parameters it was not given. A tool call *is* the model
 *   acting, so its return value is the channel: what happened, or what failed,
 *   with the command and git's own output. The model reads it and decides whether
 *   to retry — no message is pushed into the session on its behalf.
 * - **A failure is an answer, not a dead end.** `not-descendant` and a failed step
 *   come back as text, re-worded for the model rather than for a human, so the
 *   next attempt is the model's decision.
 *
 * ## Names
 *
 * `snake_case`, the harness's own convention for tool names (`write`,
 * `ask_user_question`), while the commands keep their `kebab-case` slash names.
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` and `platform` are both fair game — and
 * never upward: nothing below this layer may import it.
 *
 * @module @dsh-external/dotdsh-git-flow/tools
 */

import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";

/**
 * One tool this file defines: what the model is shown, and what runs the call.
 *
 * Generic in its arguments so a handler can name the object it reads — a tool
 * whose parameters are declared as required is a tool whose handler should say
 * so. Entries with different argument objects still share one list, because
 * {@link GIT_FLOW_TOOLS} is typed with `never`: a function that reads
 * `{ branchName: string }` is assignable where `never` is passed, and nothing is
 * assignable to `never` except what the list itself accepts.
 */
interface GitFlowTool<Args> {
  /** Name, description, and the argument schema the model must satisfy. */
  readonly descriptor: ToolSchema;
  /**
   * Run one accepted call.
   *
   * The arguments arrive already validated against the descriptor, so a handler
   * reads the fields it declared and never guards their presence — the parameter
   * type documents that contract rather than re-checking it. The returned string
   * is the text the model reads: the wiring module owns the output declaration
   * and renders it as one text block.
   *
   * @param args - the model's own arguments.
   * @param execution - the call's identity, cancellation, and calling agent.
   * @returns what the model should read next.
   */
  readonly execute: (args: Args, execution: ToolRunContext) => Promise<string>;
}

/** The `git_start` tool, as the model is shown it. */
const GIT_START_TOOL: ToolSchema = {
  name: "git_start",
  description:
    "Open a feature branch and a worktree for this session, and answer with the tree the session must work in from now on. " +
    "The branch name is required: if you cannot name the feature from what you know, ask the human what they are working on and call this again.",
  parameters: {
    branchName: {
      type: "string",
      required: true,
      description: "Name of the feature. A `feat/` prefix is added when it has none.",
    },
  },
};

/** The `git_complete` tool, as the model is shown it. */
const GIT_COMPLETE_TOOL: ToolSchema = {
  name: "git_complete",
  description:
    "Merge this session's feature branch into master with --no-ff, remove its worktree and delete the branch. " +
    "The merge message is required, because the merge commit is the only record of what the feature did. " +
    "Safe to call again: a family that is already finished reports that there is nothing to do. " +
    "A call that reports the branch is not a descendant of master means it must be replayed onto master first; " +
    "a call that reports a failed step returns that step, its git command and git's own output.",
  parameters: {
    mergeMessage: {
      type: "string",
      required: true,
      description: "Commit subject for the merge, in the repository's own commit-message style.",
    },
  },
};

/** The `git_cleanup` tool, as the model is shown it. */
const GIT_CLEANUP_TOOL: ToolSchema = {
  name: "git_cleanup",
  description:
    "Reclaim the branches and worktrees left behind by sessions that can no longer come back. " +
    "Takes no argument, is safe to call at any time, and never touches a claim whose session can still be resumed.",
  parameters: {},
};

/**
 * `git_start` — open a feature branch for this session.
 *
 * Required argument: `branchName`. It is normalized here (the `feat/` prefix is
 * added when missing) and the worktree takes the same name, so the two can never
 * disagree about which feature this is.
 *
 * The answer is where the session works from now on: the branch, and the absolute
 * path of the worktree every following edit must be inside. A family that already
 * holds a claim is refused by `core.gitStart` rather than moved to a second tree.
 *
 * @param args - the model's arguments, with `branchName` validated as present.
 * @param execution - the call, whose agent carries the session and the runner.
 * @returns where the session now works.
 */
async function gitStartTool(
  args: { readonly branchName: string },
  execution: ToolRunContext,
): Promise<string> {
  throw new Error("gitStartTool is not implemented");
}

/**
 * `git_complete` — merge the family's branch back and release it.
 *
 * Required argument: `mergeMessage`. `core.gitComplete` is re-entrant, so this is
 * safe to call again after any answer, including a failing one.
 *
 * Every outcome is a value, and every one of them is text for the model:
 *
 * - `done` — merged (or there was nothing to merge) and the family was released;
 * - `nothing-to-do` — no claim: a previous call already finished it;
 * - `not-descendant` — nothing was written; the branch has to be replayed onto
 *   master before a merge means anything, and the answer says so;
 * - `failed` — the step that stopped, its git command, and git's own output, for
 *   the model to decide whether a retry is worth it.
 *
 * @param args - the model's arguments, with `mergeMessage` validated as present.
 * @param execution - the call, whose agent carries the session and the runner.
 * @returns what happened, phrased for the model.
 */
async function gitCompleteTool(
  args: { readonly mergeMessage: string },
  execution: ToolRunContext,
): Promise<string> {
  throw new Error("gitCompleteTool is not implemented");
}

/**
 * `git_cleanup` — reclaim what unrecoverable sessions left behind.
 *
 * Takes no argument: a sweep is "now", and its scope — the sessions that can
 * still be resumed — is read the same way the command reads it, from the calling
 * agent rather than from the model. Everything outside that scope loses its
 * claim, its worktree and its branch.
 *
 * @param execution - the call, whose agent carries the session, the runner and
 *   the sweep scope.
 * @returns what the sweep did.
 */
async function gitCleanupTool(execution: ToolRunContext): Promise<string> {
  throw new Error("gitCleanupTool is not implemented");
}

/**
 * Every tool this plugin registers.
 *
 * The list is the interface: a wiring module iterates it, registers each
 * descriptor with the executor beside it, and never needs to know how many
 * operations exist or what they are called.
 *
 * Typed with `never`, which is what lets entries whose arguments differ share one
 * array — see {@link GitFlowTool}. A wiring module forwards the registry's own
 * already-validated arguments, so it passes an `unknown`; the argument type on
 * each entry is there for whoever reads or implements that handler.
 */
export const GIT_FLOW_TOOLS: readonly GitFlowTool<never>[] = [
  { descriptor: GIT_START_TOOL, execute: gitStartTool },
  { descriptor: GIT_COMPLETE_TOOL, execute: gitCompleteTool },
  { descriptor: GIT_CLEANUP_TOOL, execute: gitCleanupTool },
];
