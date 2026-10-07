/**
 * The pre-dispatch guard: one hook, two questions — may this session change that
 * file, and may the model finish this family?
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
 * The **write** question is answered `allow` or `deny`, and its reader is the
 * model: a session that may not write is told so, in the terms it needs — "call
 * `git_start` with a branch name, then repeat the change" — and the model decides
 * what to do about it. It never *starts* anything on its own initiative: naming a
 * feature and opening a branch are the model's calls, made where a human can be
 * asked, and a guard that made them itself would be deciding with no one watching.
 *
 * The **completion** question is the one place this plugin consults a human,
 * because it is the one decision the model cannot make. `git_complete` merges with
 * `--no-ff`, removes the family's worktree and deletes its branch, so what it
 * settles is not whether the work is *done* — the model knows that — but whether it
 * is *accepted*, which only the human knows. The call is therefore answered `ask`,
 * through the harness's approval seam: a single approval lets that one call
 * through, and a rejection, a cancellation or a deployment with no approval channel
 * leaves the branch exactly as it was. The model can still *propose* the merge — it
 * composes the message, which is the judgement it is best at, and the reason the
 * human reads carries it — but it cannot close a family the human has not accepted.
 * A call for a family that holds no claim passes through instead: `core.gitComplete`
 * answers `nothing-to-do` for it, and asking a human to approve a no-op is how a
 * prompt teaches its reader to approve without reading.
 *
 * ## The rules
 *
 * A write is allowed when it lands inside the tree its own family claimed, and
 * refused otherwise; a completion is asked about. The whole guard can also be
 * switched off — `guard: "off"` in the row's configuration — which is the escape
 * hatch for a session that has to write somewhere these rules refuse: with the
 * guard off the workflow is advisory, neither question is answered here, and the
 * model may finish a family unasked.
 *
 * 1. only the harness's file-mutating tools, and the one completion tool, are its
 *    business — everything else is `next()`, including a call that carries no agent
 *    at all, which is a call no session asked for and therefore nothing this plugin
 *    can have an opinion about;
 * 2. a call that declares no target is `next()`: there is nothing to check;
 * 3. a target outside the repository is `next()`: this plugin has no opinion
 *    about files it does not own;
 * 4. a family with no claim is refused, and told to open a branch first — this is
 *    the ordinary first-write case, not an error;
 * 5. a family with a claim writes inside its worktree and nowhere else. A write
 *    aimed at the main tree is refused with the path to use instead, because that
 *    is the one place the model cannot derive: it does not know where the family
 *    was put;
 * 6. a `git_complete` call by a family that holds a claim is `ask`, and its reason
 *    names the family's branch, the integration branch and the merge message — the
 *    three facts the human is being asked about. A call for a family with no claim,
 *    one that carries no agent, or one from a delegated teammate is `next()`: there
 *    is nothing to finish, nobody the question belongs to, or a caller the tool
 *    body refuses anyway because the workflow is the Lead's.
 *
 * Rule 6 runs before the file-writer lookup rather than after it, and both halves
 * of that matter: a rule 6 that ran for every call would be a rule that asks a
 * human about writes, and a rule 1 that ran first would wave a completion through.
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
import { isTopLevelSession } from "./team.js";

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
 * The one call that finishes a family, and the one call this guard asks a human
 * about.
 *
 * A name rather than an import: `tools.ts` declares this tool, and the guard reads
 * the harness's tool names the same way {@link FILE_WRITERS} does — as strings, so
 * the two modules stay independent of each other's descriptors.
 */
const COMPLETION_TOOL = "git_complete";

/** The argument a completion call carries its merge message in. */
const MERGE_MESSAGE_ARGUMENT = "mergeMessage";

/**
 * The merge message a completion call supplies, when it supplies a usable one.
 *
 * Read the way the declared path is read: from the frozen arguments, without
 * trusting their shape. The message is the model's own words and travels into the
 * reason a human reads, which is why it is trimmed and why an empty one is
 * treated as absent rather than shown as a blank line.
 *
 * @param execution - the pending completion call.
 * @returns the message, or `undefined` when the call carries none.
 */
function mergeMessageOf(execution: ToolExecution): string | undefined {
  const args: unknown = execution.arguments;
  const declared = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const message = declared?.[MERGE_MESSAGE_ARGUMENT];
  return typeof message === "string" && message.trim() !== "" ? message.trim() : undefined;
}

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
 * Ask a human before a family is finished, or let the call through when there is
 * nothing to finish.
 *
 * Three facts decide the answer, and the filters come first because this runs
 * before a tool call like every other rule here:
 *
 * - a call that carries **no agent** is not a session's call, so it is `next()` —
 *   the answer the write rules give it too, and one the harness's own ask
 *   resolution would refuse anyway. So is a session with **no working directory**:
 *   there is no repository in which to resolve a branch;
 * - a call from a **delegated teammate** is `next()`: the branch workflow is the
 *   Lead's (`team.ts`), and the tool body refuses the call before it does
 *   anything, so there is no merge here for a human to decide;
 * - a family that holds **no claim** has nothing to finish. `core.gitComplete`
 *   reports `nothing-to-do` for that call, and a no-op is not worth a human's
 *   attention: a prompt that asks about nothing is a prompt that teaches its
 *   reader to approve without reading;
 * - otherwise the call is `ask`, and the reason carries the three facts the human
 *   is deciding — the family's branch, the integration branch, and the merge
 *   message the model composed.
 *
 * The reason is read by the **human**, not by the model: the approval seam keeps
 * the two apart, and the model learns the outcome from the harness ("the user
 * rejected tool …") rather than from this text. So it is written for someone who
 * has not read the conversation — what will happen, to which branch, and what
 * rejecting it costs (nothing: the branch, its worktree and its commits stay).
 *
 * @param execution - the pending completion call.
 * @param next - the waterfall continuation, used for the two pass-through cases.
 * @param settings - the plugin's resolved configuration.
 * @returns `ask` for a family that has something to finish; `next()` otherwise.
 */
async function askBeforeComplete(
  execution: ToolExecution,
  next: () => Promise<PreToolDecision>,
  settings: FlowSettings,
): Promise<PreToolDecision> {
  const rawAgent: unknown = execution.agent;
  if (rawAgent === undefined) return next();

  const agent = sessionAgentOf(rawAgent);
  // A delegated teammate can never finish a family: git-flow is Lead-only inside a
  // Team, and the tool body refuses the call itself (`team.leadOnlyRefusal`).
  // Passing through here is what makes that refusal *direct*: resolving the
  // workspace below would start git children and, for a family that holds a claim,
  // put a merge to a human that the tool body would then decline.
  if (!isTopLevelSession(agent.session)) return next();

  const cwd = agent.session.header.cwd;
  if (cwd === undefined) return next();

  const facts = await factsFor(agent, settings, execution.signal);
  const workspace = await ensureWorkspace(facts.flow, facts.sessionId, execution.signal);
  if (workspace === null) return next();

  const message = mergeMessageOf(execution);
  return {
    kind: "ask",
    reason:
      `Finish \`${workspace.branch}\`? Approving merges it into \`${settings.integrationBranch}\` with --no-ff, ` +
      "removes its worktree and deletes the branch — an issue found after that needs a new branch. " +
      "Reject to leave the branch, its worktree and its commits exactly as they are." +
      (message === undefined ? "" : `\nMerge message: ${message}`),
  };
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
 * The two refusals are the whole of the guard's answer to a *write*, and both are
 * addressed to the model rather than to a human. Both also name the workflow skill
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
 * A completion is the other question, and the only answer here that is not the
 * model's: see {@link askBeforeComplete}.
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

  // Checked before the lookup below, which knows nothing about it and would wave
  // it through: finishing a family is not a write, but it is the call a human has
  // to answer for.
  if (execution.name === COMPLETION_TOOL) return askBeforeComplete(execution, next, settings);

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
