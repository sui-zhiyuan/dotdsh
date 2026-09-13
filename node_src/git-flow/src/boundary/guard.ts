/**
 * The pre-write guard: one hook, one question — may this session change that file?
 *
 * `tools/pre-execute` is a waterfall that runs before a call is dispatched and
 * may return `allow`, `deny` or `ask`, which is what makes the answer
 * enforceable rather than advisory. Two properties of that seam shape everything
 * below:
 *
 * - **arguments cannot be rewritten.** There is no such decision variant, and
 *   `exec.arguments` is frozen before listeners run, so what was logged and what
 *   ran cannot diverge. A guard therefore either lets a call through or refuses
 *   it, and the refusal's text has to carry the correction.
 * - **it is on the hot path.** Nothing here runs more than it must: the tool name
 *   is filtered first, the declared path second, and only then is anything asked
 *   of the repository.
 *
 * ## What it decides, and what it refuses to decide
 *
 * It answers `allow` or `deny`, and never `ask`: the guard is not where a human
 * is consulted. It also never *starts* anything on its own initiative. A session
 * that may not write is told so, in the terms the model needs — "call `git_start`
 * with a branch name, then repeat the change" — and the model decides what to do
 * about it. Naming a feature and opening a branch are the model's calls, made
 * where a human can be asked; a guard that made them itself would be deciding
 * with no one watching.
 *
 * ## The rules
 *
 * A write is allowed when it lands inside the tree its own family claimed, and
 * refused otherwise:
 *
 * 1. only the harness's file-mutating tools are its business — everything else is
 *    `next()`, including a call that carries no agent at all, which is a call no
 *    session asked for and therefore nothing this plugin can have an opinion
 *    about;
 * 2. a call that declares no target is `next()`: there is nothing to check;
 * 3. a target outside the repository is `next()`: this plugin has no opinion
 *    about files it does not own;
 * 4. a family with no claim is refused, and told to open a branch first — this is
 *    the ordinary first-write case, not an error;
 * 5. a family with a claim writes inside its worktree and nowhere else. A write
 *    aimed at the main tree is refused with the path to use instead, because that
 *    is the one place the model cannot derive: it does not know where the family
 *    was put.
 *
 * The Bash tool is deliberately absent. Its arguments name a command, not a
 * path, so it can neither be checked for containment nor told apart from
 * `git status` — and a rule that refused every shell command would be worse than
 * the hole it closed.
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` and `platform` are both fair game — and
 * never upward: nothing below this layer may import it.
 *
 * @module @dsh-external/dotdsh-git-flow/guard
 */

import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { ensureWorkspace } from "../core/core.js";
import { GIT_FLOW_SKILL_NAMES } from "./skill.js";
import { factsFor, sessionAgentOf } from "./shared.js";

/**
 * Decide one tool call.
 *
 * The rules are in this module's header; what matters here is the order they run
 * in. The cheap filters come first — the tool name, then the declared path, which
 * is `file_path` for `write` and `edit` and `path` for `str_replace_editor`
 * unless its sub-command is `view` — because this runs before *every* tool call
 * the session makes, and the repository is asked nothing until a call has
 * survived them. The containment test is the other piece that stays here: a
 * single relative-path comparison, used once, with nothing to share it with.
 *
 * Every git call goes through the runner with `execution.signal`. The registry
 * checks cancellation before this listener runs and again after it settles, so a
 * turn that is cancelled while the guard is working is handled either way — but
 * without the signal the guard would keep running git, and keep holding the claim
 * file's lock, for a call nobody is waiting for any more.
 *
 * The two refusals are the whole of the guard's output, and both are addressed to
 * the model rather than to a human. Both also name the workflow skill
 * ({@link GIT_FLOW_SKILL_NAMES.workflow}), because a model that has just been
 * refused is a model that has not read the rules yet — and a refusal is the one
 * moment the rules can be handed to it exactly when they are needed. The name
 * comes from the skill module rather than being written here, so the instruction
 * and the skill it points at cannot drift apart.
 *
 * - **no claim** — the session has no branch and no tree yet, so a change has
 *   nowhere to land:
 *
 *   > This session has no feature branch yet, so there is nowhere for this change
 *   > to land. Load the `git-flow` skill, then call `git_start` with a branch
 *   > name — ask the human what they are working on if you cannot name it — and
 *   > repeat this change.
 *
 * - **outside the tree** — the family writes in its own worktree and nowhere
 *   else. The refusal names the exact path to use instead, because the model
 *   cannot derive where its family was put:
 *
 *   > This session writes inside its own worktree, at `<worktree>`. Load the
 *   > `git-flow` skill, and write to `<worktree>/<relative>` instead of
 *   > `<target>`.
 *
 * @param execution - the pending call: name, arguments, and calling agent.
 * @param next - the waterfall continuation, which allows the call.
 * @returns the decision.
 */
async function beforeToolCall(
  execution: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  throw new Error("beforeToolCall is not implemented");
}

/**
 * The one hook this plugin intercepts.
 *
 * A single object rather than a list: there is exactly one interception point,
 * and a list of one would only invite the question of what a second would mean.
 * Typed `as const` so `hook` stays the literal the harness's listener overloads
 * resolve against. The wiring module registers it as it stands:
 *
 * ```ts
 * ctx.effect(() => ctx.on(GIT_FLOW_INTERCEPTOR.hook, GIT_FLOW_INTERCEPTOR.handle));
 * ```
 */
export const GIT_FLOW_INTERCEPTOR = {
  hook: "tools/pre-execute",
  handle: beforeToolCall,
} as const;
