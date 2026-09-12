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
import { gitClient } from "./exec.js";
import { nodeFileAccess } from "./file-access.js";
import { startFlow } from "./flow.js";
import { otherLiveClaims } from "./repo.js";
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
  if (!isFileTool && !isBash) return next();

  const agent = exec.agent;
  if (agent === undefined) return next();
  const cwd = sessionCwd(agent);
  if (cwd === undefined) return next();

  const declared = isFileTool ? declaredTarget(exec.name, exec.arguments) : undefined;
  if (isFileTool && declared === undefined) return next();

  const git = gitClient(runtime.runner, cwd);
  const identity = sessionRoot(agent, runtime.sessions);
  const snapshot = await runtime.state.refresh(git, agent, config, identity);
  if (snapshot.repoRoot === undefined) return next();

  const target = declared === undefined ? undefined : resolve(cwd, declared);
  if (target !== undefined && !isInside(snapshot.repoRoot, target)) return next();

  // Isolation is only real if it is enforced. A session that has a worktree must
  // edit inside it: the point of the worktree is that simultaneous edits cannot
  // collide, and a write to the main tree would collide with whoever is there.
  if (target !== undefined && snapshot.worktreePath !== null && !isInside(snapshot.worktreePath, target)) {
    const redirected = join(snapshot.worktreePath, relative(snapshot.repoRoot, target));
    return {
      kind: "deny",
      reason:
        `this session works in its own worktree at ${snapshot.worktreePath}, because another session is using ` +
        `the main tree. Write to ${redirected} instead of ${target}.`,
    };
  }

  // Whether another session is in *this* checkout, which is a different question
  // from whether other sessions exist at all. Two sessions sharing one working
  // directory is the dangerous shape: the first opens a feature branch there, so
  // the second no longer sees the integration branch checked out — it sees the
  // first session's branch — and would quietly write onto it. So this test has to
  // run *before* the integration-branch test, not after it: the case it catches is
  // precisely a branch that is not the integration branch.
  //
  // The claim is verified against git rather than trusted from the ledger: a record
  // whose branch is not the one actually checked out here is stale — the human
  // switched back, or that session finished without `/git-complete` — and a stale
  // record must not block a tree nobody is using.
  const { others } = await otherLiveClaims(git, identity, runtime.sessions, runtime.pid);
  const inMainTree = snapshot.mainTree !== undefined && snapshot.mainTree === snapshot.repoRoot;
  const claimant = others.find(
    (record) =>
      record.branch === snapshot.branch &&
      (record.worktreePath === null
        ? inMainTree
        : resolve(record.worktreePath) === resolve(snapshot.repoRoot ?? "")),
  );
  if (claimant !== undefined) {
    return {
      kind: "deny",
      reason:
        `another live session is working in this same checkout on \`${claimant.branch}\`, so writing here would ` +
        "land on its branch. Run `/git-start` so this session gets its own branch and its own worktree.",
    };
  }

  if (!snapshot.onIntegration) return next();

  const branch = snapshot.branch ?? "the integration branch";
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
      files: nodeFileAccess,
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
    runtime.state.invalidateRepos();
    await runtime.state.refresh(git, agent, config, identity);

    // A start that isolated this session leaves the write that triggered it
    // pointing at the tree the session just left. Allowing it would defeat the
    // isolation on its very first use, so the model is sent to the same file
    // inside the worktree instead — the redirect the seam cannot perform itself.
    const worktreePath = result.worktreePath;
    if (worktreePath !== null && target !== undefined && !isInside(worktreePath, target)) {
      const redirected = join(worktreePath, relative(snapshot.repoRoot ?? "", target));
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
