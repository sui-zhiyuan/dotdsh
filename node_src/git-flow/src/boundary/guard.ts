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
 * refused otherwise. The whole guard can also be switched off — `guard: "off"` in
 * the row's configuration — which is the escape hatch for a session that has to
 * write somewhere these rules refuse: with the guard off, the workflow is advisory
 * and nothing below runs.
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

import { isAbsolute, join, relative, resolve } from "node:path";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { ensureWorkspace } from "../core/core.js";
import type { FlowSettings } from "../platform/settings.js";
import { GIT_FLOW_SKILL_NAMES } from "./skill.js";
import { factsFor, sessionAgentOf } from "./shared.js";

/**
 * The tools that can change a file, and the argument each declares its target
 * in.
 *
 * Modelled on the harness's tool names rather than on the call, so the check is
 * a lookup and not a per-tool branch. A tool that is missing here is not
 * guarded, which is the deliberate hole the module header describes for `bash`.
 */
const FILE_WRITERS: ReadonlyMap<string, string> = new Map([
  ["write", "file_path"],
  ["edit", "file_path"],
  ["str_replace_editor", "path"],
]);

/**
 * The `str_replace_editor` sub-command that only reads.
 *
 * The tool carries both reads and writes, and its target argument says nothing
 * about which this call is, so the sub-command is the only way to tell them
 * apart. Refusing a view would be worse than the hole it closed.
 */
const READ_ONLY_SUBCOMMAND = "view";

/**
 * Whether `child` is `parent` or sits inside it.
 *
 * Both are absolute and already resolved; the comparison is `path.relative` so
 * it is segment-wise rather than prefix-wise, which is what keeps `/repo-other`
 * from reading as inside `/repo`.
 *
 * @param parent - the directory claimed to contain `child`.
 * @param child - the candidate to test.
 * @returns whether `child` is inside `parent`.
 */
function isInside(parent: string, child: string): boolean {
  const offset = relative(parent, child);
  return offset === "" || (!offset.startsWith("..") && !isAbsolute(offset));
}

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
 * This listener reaches git in exactly two places, `factsFor` and
 * `ensureWorkspace`, and each is handed `execution.signal`: that is what makes the
 * cancellation below reach the runner, so a cancelled turn stops the guard at its
 * next git step instead of holding the claim file's lock for a call nobody is
 * waiting for any more. The registry checks cancellation before this listener runs
 * and again after it settles, so a turn cancelled while the guard is working is
 * handled either way.
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
 * @param settings - the plugin's resolved configuration; `guard: "off"` turns the
 *   whole listener into a pass-through.
 * @returns the decision.
 */
async function beforeToolCall(
  execution: ToolExecution,
  next: () => Promise<PreToolDecision>,
  settings: FlowSettings,
): Promise<PreToolDecision> {
  // Off means off, before anything is looked at: not even the tool name is worth
  // reading when the answer is always the same.
  if (settings.guard === "off") return next();

  const targetArgument = FILE_WRITERS.get(execution.name);
  if (targetArgument === undefined) return next();

  const args: unknown = execution.arguments;
  const declared = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;

  const declaredPath = declared?.[targetArgument];
  if (typeof declaredPath !== "string" || declaredPath.length === 0) return next();

  // `view` is a read wearing a mutating tool's name, and it is the one
  // sub-command whose argument set this guard cannot mistake for a write.
  if (execution.name === "str_replace_editor" && declared?.["command"] === READ_ONLY_SUBCOMMAND) return next();

  // `execution.agent` is optional, and a call no session asked for is one this
  // plugin has nothing to say about.
  const rawAgent: unknown = execution.agent;
  if (rawAgent === undefined) return next();

  const agent = sessionAgentOf(rawAgent);
  const cwd = agent.session.header.cwd;
  // Without a working directory there is no way to say where the declared path
  // points, and a guess is the one thing a guard must not do.
  if (cwd === undefined) return next();

  const target = resolve(cwd, declaredPath);

  const facts = await factsFor(agent, settings, execution.signal);
  if (!isInside(facts.flow.repoRoot, target)) return next();

  const workspace = await ensureWorkspace(facts.flow, facts.sessionId, execution.signal);
  if (workspace === null) {
    return {
      kind: "deny",
      reason:
        `This session has no feature branch yet, so there is nowhere for this change to land. ` +
        `Load the \`${GIT_FLOW_SKILL_NAMES.workflow}\` skill, then call \`git_start\` with a branch name ` +
        `— ask the human what they are working on if you cannot name it — and repeat this change.`,
    };
  }

  if (isInside(workspace.workTree, target)) return next();

  // The redirected path is the target's own position under the repository,
  // re-rooted at the worktree: the model cannot derive where its family was put,
  // so the refusal has to spell the path out.
  const redirected = join(workspace.workTree, relative(facts.flow.repoRoot, target));
  return {
    kind: "deny",
    reason:
      `This session writes inside its own working tree, at \`${workspace.workTree}\`. ` +
      `Load the \`${GIT_FLOW_SKILL_NAMES.workflow}\` skill, and write to \`${redirected}\` instead of \`${target}\`.`,
  };
}

/**
 * The one hook this plugin intercepts.
 *
 * A single object rather than a list: there is exactly one interception point,
 * and a list of one would only invite the question of what a second would mean.
 * Typed `as const` so `hook` stays the literal the harness's listener overloads
 * resolve against. The wiring module is the one that holds the settings, so it
 * closes over them:
 *
 * ```ts
 * ctx.effect(() =>
 *   ctx.on(GIT_FLOW_INTERCEPTOR.hook, (execution, next) =>
 *     GIT_FLOW_INTERCEPTOR.handle(execution, next, settings),
 *   ),
 * );
 * ```
 */
export const GIT_FLOW_INTERCEPTOR = {
  hook: "tools/pre-execute",
  handle: beforeToolCall,
} as const;
