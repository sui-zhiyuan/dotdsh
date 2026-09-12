/**
 * The pre-write guard: the invariant behind requirement "before any file is
 * modified, if the integration branch is checked out, start a feature branch".
 *
 * ## Why this seam
 *
 * `tools/pre-execute` is a waterfall that runs before dispatch and may return
 * `allow`, `deny` or `ask` — it can genuinely stop a call, which is what makes the
 * invariant enforceable rather than advisory. Three properties of the seam shape
 * the implementation:
 *
 * - **arguments cannot be rewritten.** There is no such decision variant;
 *   `exec.arguments` is deep-frozen before listeners run, so that what was logged
 *   and what ran cannot diverge. A guard therefore either lets a call through or
 *   refuses it — it cannot redirect a path, and the denial message has to carry
 *   the correction.
 * - **it is asynchronous.** A gate may run git, as long as it observes
 *   `exec.signal`. (The synchronous alternative, `ctx.tools.guard`, could not:
 *   deciding this requires asking git a question.)
 * - **it is on the hot path**, so nothing here runs more than it must: the tool
 *   name is filtered first, the target path second, and only then is git asked.
 *
 * ## What it refuses to guess
 *
 * Opening a branch automatically is only unambiguous when this session is the
 * only live one in the repository. When others are present, a branch is opened
 * per session through a worktree, and a *subagent* shares its parent's working
 * directory — auto-starting there would silently put a child on a different
 * checkout from the parent that dispatched it. So the guard auto-starts only in
 * the unambiguous case and otherwise denies with instructions, which is the one
 * outcome that cannot corrupt anything.
 *
 * @module @dsh-external/dotdsh-git-flow/guard
 */

import { isAbsolute, relative, resolve, join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision, ToolExecution } from "@deepseek-ai/dsh-tools";
import { ensureClaim } from "./claim.js";
import { gitClient } from "./exec.js";
import { startFlow } from "./flow.js";
import { otherLiveClaims, type SessionClaim } from "./repo.js";
import type { Runtime } from "./runtime.js";
import { isDelegate, sessionCwd, sessionIntent, sessionRoot, type AgentLike } from "./session.js";

/**
 * Tools that write files, and the argument naming the file they write.
 *
 * These are the exact registered names of the harness's own file tools: `write`
 * and `edit` from `@deepseek-ai/dsh-tool-fs`, and `str_replace_editor`. The Bash
 * tool is deliberately absent — see {@link guardCall}.
 */
const FILE_TOOLS = new Set(["write", "edit", "str_replace_editor"]);

/**
 * The path a mutating call declares, when it declares one.
 *
 * `str_replace_editor` is checked against its own sub-command: `view` is a read,
 * and a guard that blocked reading a file would be worse than no guard.
 *
 * @param name - the tool's registered name.
 * @param args - the call's parsed arguments.
 * @returns the declared path, or `undefined` when the call declares none.
 */
function declaredTarget(name: string, args: unknown): string | undefined {
  if (typeof args !== "object" || args === null) return undefined;
  const record = args as Record<string, unknown>;
  const stringField = (key: string): string | undefined => {
    const value = record[key];
    return typeof value === "string" && value !== "" ? value : undefined;
  };

  if (name === "write" || name === "edit") return stringField("file_path");
  if (name === "str_replace_editor") {
    const command = stringField("command");
    if (command === undefined || command === "view") return undefined;
    return stringField("path");
  }
  return undefined;
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
 * The working tree a claim owns, when it owns one.
 *
 * A claim owns a tree only once that tree exists. An assignment to an own tree
 * whose worktree has not been created yet competes for nothing, which is what keeps
 * a claim written at the first write from refusing writes that would not collide.
 *
 * @param claim - another family's claim.
 * @returns the absolute path of the tree it owns, or `undefined`.
 */
function ownedTreeOf(claim: SessionClaim): string | undefined {
  if (claim.tree === "own") return claim.worktreePath ?? undefined;
  return claim.repoRoot === "" ? undefined : claim.repoRoot;
}

/**
 * Decide one file-mutating call.
 *
 * Exported for the committed check: the decision is a plain function of a runtime,
 * a pending call and the continuation, so it can be driven against a scratch
 * repository with no harness present — which is the only way this requirement gets
 * covered by `pnpm test` rather than by a human remembering to try it.
 *
 * @param runtime - the plugin runtime.
 * @param exec - the pending call.
 * @param next - the waterfall continuation, which allows the call.
 * @returns the decision.
 */
export async function decideToolCall(
  runtime: Runtime,
  exec: ToolExecution,
  next: () => Promise<PreToolDecision>,
): Promise<PreToolDecision> {
  const { config } = runtime;
  if (config.guard === "off") return next();

  const isFileTool = FILE_TOOLS.has(exec.name);
  // The Bash tool is opt-in. Its arguments name a command, not a path, so it can
  // neither be checked for containment nor be told apart from `git status` — with
  // it enabled, every shell command a session runs would open a branch on the
  // integration branch, including the ones that touch nothing.
  const isBash = exec.name === "bash" && config.guardBash;

  const agent = exec.agent;
  if (agent === undefined) return next();
  const cwd = sessionCwd(agent);
  if (cwd === undefined) return next();

  // Nothing else is this plugin's business. A read-only call is not guarded, not
  // claimed, and not observed: the model is not told where it stands (see
  // `prompt.ts`), so there is no cached fact for a read to keep fresh.
  if (!isFileTool && !isBash) return next();

  const declared = isFileTool ? declaredTarget(exec.name, exec.arguments) : undefined;
  if (isFileTool && declared === undefined) return next();

  const git = gitClient(runtime.runner, cwd);
  const identity = sessionRoot(agent, runtime.sessions);
  const here = await runtime.state.position(git, agent, config, identity);
  const root = here.repoRoot;
  if (root === undefined) return next();

  // A write that goes somewhere else is not this plugin's business at all, and that
  // is decided *before* claiming: a claim means "this family works in this repository",
  // and a session whose first edit lands outside it has not said that.
  const target = declared === undefined ? undefined : resolve(cwd, declared);
  if (target !== undefined && !isInside(root, target)) return next();

  // Everything below decides where this session may write, and the first fact it needs
  // is which tree it is assigned. Claiming here rather than before the model thinks is
  // what keeps read-only work free: a session can explore, and settle a branch and
  // worktree name with the human, without declaring anything. A claim exists to precede
  // a write, and this is the last moment before one.
  const claim = await ensureClaim({
    git,
    sessionId: identity,
    pid: runtime.pid,
    registry: runtime.sessions,
    config,
    latch: runtime.latch,
    ...(runtime.log === undefined ? {} : { log: runtime.log }),
  });
  if (claim.kind === "blocked") return { kind: "deny", reason: claim.reason };

  // The claim may have just decided the assignment, and every test below reads it, so
  // the position is taken again rather than reused. Nothing about a *position* is
  // cached — the branch and the worktree are exactly the facts that can change between
  // two tool calls.
  const position = claim.changed ? await runtime.state.position(git, agent, config, identity) : here;

  // Isolation is only real if it is enforced. A session that has a worktree must
  // edit inside it: the point of the worktree is that simultaneous edits cannot
  // collide, and a write to the main tree would collide with whoever is there.
  //
  // This refusal is also the only place the model is ever told where to write, since
  // the prompt no longer says which branch or worktree a session has. That is why the
  // message carries both paths rather than a diagnosis: for the model it *is* the
  // instruction.
  if (target !== undefined && position.worktreePath !== null && !isInside(position.worktreePath, target)) {
    const redirected = join(position.worktreePath, relative(root, target));
    return {
      kind: "deny",
      reason:
        `this session works in its own worktree at ${position.worktreePath}, because another session is using ` +
        `the main tree. Write to ${redirected} instead of ${target}.`,
    };
  }

  // Whether another family owns *this* tree, which is a different question from
  // whether other families exist. Two sessions sharing one working directory is the
  // dangerous shape: the first opens a feature branch there, so the second no longer
  // sees the integration branch checked out — it sees the first session's branch —
  // and would quietly write onto it. So this test has to run *before* the
  // integration-branch test, not after it: the case it catches is precisely a branch
  // that is not the integration branch.
  //
  // The comparison is on **trees**, not branches. Ownership is what the ledger
  // records, and a recorded branch goes stale the moment a human switches branches
  // by hand, while "which tree does this family own" does not. A claim owns a tree
  // only once that tree exists: an assignment to an own tree that has not been
  // created yet competes for nothing.
  //
  // The refusal below is scoped to what the auto-start cannot fix. On the integration
  // branch with isolation enabled, another family owning this tree is *not* a refusal
  // — it is the situation the auto-start exists for, and it answers by giving this
  // session a tree of its own and sending the triggering write there. Refusing would
  // send the human to `/git-start` to do what the guard was about to do. What is left
  // for this test is the tree a session stands in and cannot be moved out of by
  // opening a branch: another family's checkout while this session is already on a
  // feature branch — or isolation switched off, in which case starting in place would
  // create the very collision this test prevents.
  const { others } = await otherLiveClaims(git, identity, runtime.sessions, runtime.pid);
  const claimant = others.find((record) => {
    const owned = ownedTreeOf(record);
    return owned !== undefined && resolve(owned) === resolve(root);
  });
  if (claimant !== undefined && !(position.onIntegration && config.useWorktreeWhenBusy)) {
    return {
      kind: "deny",
      reason:
        `another live session is working in this same checkout${
          claimant.branch === null ? "" : ` on \`${claimant.branch}\``
        }, so writing here would land on its branch. Run \`/git-start\` so this session gets its own branch and ` +
        "its own worktree.",
    };
  }

  if (!position.onIntegration) return next();

  const branch = position.branch ?? "the integration branch";
  if (config.guard === "block") {
    return {
      kind: "deny",
      reason:
        `${branch} is the integration branch, and this workflow never writes to it directly. ` +
        "Run `/git-start` (optionally `/git-start <name>`) to open a feature branch, then make the change.",
    };
  }

  // The namer is built from *this* agent, because the model route is the agent's.
  // An absent factory is worth saying out loud: it is installed by a *scoped*
  // injection that starts a child plugin, and a child plugin whose dependencies
  // never resolve simply never runs — there is no error, and without this line the
  // only symptom is a branch name that could not be found.
  const namer = runtime.namerFor?.(agent);
  if (namer === undefined) {
    runtime.log?.warn(
      "git-flow: no model-backed namer is installed (the scoped llm/agentDefaultModel injection did not " +
        "activate), so a prompt the naming rules cannot slug has to be named by hand",
    );
  }
  const result = await startFlow(
    {
      git,
      sessionId: identity,
      isDelegate: isDelegate(agent),
      pid: runtime.pid,
      registry: runtime.sessions,
      config,
      ...(namer === undefined ? {} : { namer }),
      signal: exec.signal,
    },
    sessionIntent(agent),
  );

  if (result.kind === "started" || result.kind === "already-on-feature") {

    // A start that isolated this session leaves the write that triggered it
    // pointing at the tree the session just left. Allowing it would defeat the
    // isolation on its very first use, so the model is sent to the same file
    // inside the worktree instead — the redirect the seam cannot perform itself.
    const worktreePath = result.worktreePath;
    if (worktreePath !== null && target !== undefined && !isInside(worktreePath, target)) {
      const redirected = join(worktreePath, relative(root, target));
      return {
        kind: "deny",
        reason:
          `this session now works in its own worktree at ${worktreePath}, because another session is using the ` +
          `main tree. Write to ${redirected} instead of ${target}.`,
      };
    }
    return next();
  }

  const detail = result.kind === "need-name" ? result.reason : result.kind === "blocked" ? result.reason : "";
  // The reason distinguishes "there was no namer to ask" from "the namer was asked
  // and declined". Collapsing those two into one sentence cost a debugging session:
  // they need different fixes, and only one of them is the model's fault.
  const cause =
    namer === undefined
      ? "this build has no model-backed namer installed, so only the naming rules could be tried"
      : "the naming rules declined and the model produced no usable name";
  return {
    kind: "deny",
    reason:
      `this change would land on ${branch}, and a feature branch could not be opened automatically (${cause}; ` +
      `${detail}). Name the feature and run \`/git-start <name>\`, then repeat the change.`,
  };
}

/**
 * Register the pre-write guard.
 *
 * @param ctx - the plugin context, with `tools` injected.
 * @param runtime - the plugin runtime.
 * @returns a disposer that removes the listener.
 */
export function registerGuard(ctx: Context, runtime: Runtime): () => void {
  const dispose = ctx.on("tools/pre-execute", (exec, next) => decideToolCall(runtime, exec, next));
  return () => {
    dispose();
  };
}
