/**
 * `/git-start` and `/git-complete`.
 *
 * A command handler runs against the receiving agent and its result is **not**
 * sent to the model, which is what makes these two worth having as commands at
 * all: opening and finishing a branch are decisions the human makes and wants to
 * see the outcome of, not instructions the model has to be trusted to carry out.
 *
 * The one outcome that is neither success nor failure is a missing name: when the
 * session's intent cannot be reduced to a branch name, the handler asks. It
 * reports that as a success with a question in it, because nothing went wrong —
 * the workflow is waiting on the human.
 *
 * @module @dsh-external/dotdsh-git-flow/commands
 */

import type { Context } from "@deepseek-ai/cordis";
import type { CommandInvocation } from "@deepseek-ai/dsh-commands";
import { gitClient, type Git } from "./exec.js";
import { hasBranchPrefix } from "./branch.js";
import { nodeFileAccess } from "./file-access.js";
import { completeFlow, startFlow, type CompleteResult, type FlowDeps, type StartResult } from "./flow.js";
import type { Runtime } from "./runtime.js";
import { sessionCwd, sessionId, sessionIntent, type AgentLike } from "./session.js";

/** The description shown in command discovery for `/git-start`. */
const START_DESCRIPTION =
  "Open a feature branch for this session, named from what the session is working on (or from the name you pass)";

/** The description shown in command discovery for `/git-complete`. */
const COMPLETE_DESCRIPTION =
  "Replay the feature branch if the integration branch moved, merge it with --no-ff, remove its worktree, delete it";

/**
 * Assemble the flow dependencies for one invocation.
 *
 * @param runtime - the plugin runtime.
 * @param agent - the receiving agent.
 * @param git - a client bound to the session's working directory.
 * @param signal - cancellation owned by the dispatching UI request.
 * @returns the dependencies a flow run needs.
 */
function depsFor(runtime: Runtime, agent: AgentLike, git: Git, signal: AbortSignal): FlowDeps {
  // Built per call from this agent: the model route belongs to the agent.
  const namer = runtime.namerFor?.(agent);
  return {
    git,
    files: nodeFileAccess,
    sessionId: sessionId(agent),
    pid: runtime.pid,
    config: runtime.config,
    ...(namer === undefined ? {} : { namer }),
    signal,
  };
}

/**
 * Normalize a human-supplied branch name.
 *
 * A name typed after the command is taken as the feature's own name and given the
 * configured prefix when it lacks one, so that the later `/git-complete` — which
 * recognises a branch by that prefix — always sees the same shape the plugin
 * created. `check-ref-format --branch` is git's own validator, so anything git
 * would refuse is refused here, with a message that says so.
 *
 * @param git - a client for the repository.
 * @param raw - the text the human typed after the command.
 * @param prefix - the configured branch prefix.
 * @returns the full branch name, `undefined` when none was given, or an error.
 */
async function normalizeName(
  git: Git,
  raw: string,
  prefix: string,
): Promise<{ readonly name: string | undefined } | { readonly error: string }> {
  const typed = raw.trim().replace(/^\/+/, "");
  if (typed === "") return { name: undefined };

  const name = hasBranchPrefix(typed, prefix) ? typed : `${prefix}${typed}`;
  if (!(await git.ok(["check-ref-format", "--branch", name]))) {
    return { error: `\`${name}\` is not a valid branch name.` };
  }
  return { name };
}

/**
 * Render the outcome of `/git-start`.
 *
 * @param result - the flow outcome.
 * @returns the text the human sees.
 */
function reportStart(result: StartResult): { readonly kind: "success" | "error"; readonly text: string } {
  switch (result.kind) {
    case "started": {
      const lines = [`Opened \`${result.branch}\` from \`${result.integration}\`.`];
      if (result.worktreePath !== null) {
        lines.push(
          "",
          `${String(result.parallelSessions)} other live session(s) in this repository, so this session is ` +
            `isolated in its own worktree:`,
          `  ${result.worktreePath}`,
          "",
          "Make every file edit there, using absolute paths.",
        );
      }
      if (result.ignoreChanged) {
        lines.push(
          "",
          `Added \`${result.gitignorePattern ?? ""}\` to ${result.gitignorePath ?? ".gitignore"} with a comment explaining it. ` +
            "A git worktree is a linked repository, so without that rule a `git add --all` in the main tree would " +
            "stage it as an embedded repository pointing at a commit that disappears when the worktree does.",
        );
      }
      if (result.trackedGitlink) {
        lines.push(
          "",
          "Warning: this worktree root is **already recorded in the index** as an embedded repository. " +
            "An ignore rule cannot undo that — remove the entry with `git rm --cached <path>` before committing.",
        );
      }
      if (result.outstandingBranches.length > 0) {
        lines.push(
          "",
          `Heads up: ${String(result.outstandingBranches.length)} branch(es) in this repository are left over from ` +
            "sessions that are no longer running, with commits that were never merged back:",
          ...result.outstandingBranches.map((branch) => `  ${branch}`),
          "Their records were dropped — nothing can resume them. Merge or delete them by hand when you know which.",
        );
      }
      lines.push("", "Commit each completed step; `/git-complete` merges the feature back when it is done.");
      return { kind: "success", text: lines.join("\n") };
    }
    case "already-on-feature":
      return {
        kind: "success",
        text:
          `Already on \`${result.branch}\`, so there is nothing to open. ` +
          (result.worktreePath === null ? "" : `This session's worktree is ${result.worktreePath}.`),
      };
    case "need-name":
      return {
        kind: "success",
        text: [
          "I cannot name this feature from the session so far — nothing in it reduces to a branch name.",
          "",
          "Give the branch a name:",
          "",
          "  /git-start <name>",
          "",
          "or describe what you are working on and I will name it.",
        ].join("\n"),
      };
    case "blocked":
      return { kind: "error", text: result.reason };
  }
}

/**
 * Render the outcome of `/git-complete`.
 *
 * @param result - the flow outcome.
 * @returns the text the human sees.
 */
function reportComplete(result: CompleteResult): { readonly kind: "success" | "error"; readonly text: string } {
  switch (result.kind) {
    case "merged": {
      const lines = [
        `Merged \`${result.branch}\` into \`${result.integration}\` as ${result.mergeCommit.slice(0, 8)}.`,
      ];
      if (result.rebased) {
        lines.push(
          `  replayed the branch onto \`${result.integration}\` first (from ${String(result.rebasedFrom).slice(0, 8)}), ` +
            "because the integration branch had moved since the branch point",
        );
      }
      if (result.collectedCommit !== undefined) {
        lines.push(`  collected uncommitted work into ${result.collectedCommit.slice(0, 8)}`);
      }
      if (result.removedWorktree !== null) lines.push(`  removed the worktree ${result.removedWorktree}`);
      if (result.deletedBranch) lines.push(`  deleted \`${result.branch}\``);
      for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
      return { kind: "success", text: lines.join("\n") };
    }
    case "no-changes":
      return {
        kind: "success",
        text:
          `Nothing to merge: ${result.reason}. The branch is still there — commit something on it first, ` +
          "or delete it with `git branch -D` if it was a false start.",
      };
    case "conflicted": {
      const remedy =
        result.during === "rebase"
          ? [
              "The replay was aborted and the branch is exactly where it was. Resolve it by hand and run",
              "`/git-complete` again:",
              `  git rebase --onto ${result.integration} $(git merge-base ${result.integration} ${result.branch}) ${result.branch}`,
            ]
          : [
              `The branch replayed cleanly but its merge into \`${result.integration}\` was aborted, and the branch`,
              "is exactly where it was. Merge it by hand and commit the resolution:",
              `  git -C <the tree holding ${result.integration}> merge --no-ff ${result.branch}`,
            ];
      return {
        kind: "error",
        text: [
          `\`${result.branch}\` conflicts with \`${result.integration}\` in ${String(result.files.length)} file(s):`,
          ...result.files.map((file) => `  ${file}`),
          "",
          ...remedy,
          "Nothing was resolved automatically and nothing was force-pushed.",
        ].join("\n"),
      };
    }
    case "need-branch":
      return { kind: "error", text: result.reason };
    case "blocked":
      return { kind: "error", text: result.reason };
  }
}

/**
 * Register both slash commands.
 *
 * @param ctx - the plugin context, with `commands` injected.
 * @param runtime - the plugin runtime.
 * @returns a disposer that unregisters both commands.
 */
export function registerCommands(ctx: Context, runtime: Runtime): () => void {
  const disposers = [
    ctx.commands.register({
      name: "git-start",
      description: START_DESCRIPTION,
      async handler(invocation: CommandInvocation) {
        const agent = invocation.agent;
        const cwd = sessionCwd(agent);
        if (cwd === undefined) {
          return { kind: "error", text: "This session has no working directory, so there is no repository to use." };
        }

        const git = gitClient(runtime.runner, cwd);
        const normalized = await normalizeName(git, invocation.rawInput, runtime.config.branchPrefix);
        if ("error" in normalized) return { kind: "error", text: normalized.error };

        const result = await startFlow(
          depsFor(runtime, agent, git, invocation.signal),
          sessionIntent(agent),
          normalized.name,
        );
        if (result.kind === "started" || result.kind === "already-on-feature") {
          runtime.state.invalidateRepos();
          await runtime.state.refresh(git, agent, runtime.config);
        }
        return reportStart(result);
      },
    }),
    ctx.commands.register({
      name: "git-complete",
      description: COMPLETE_DESCRIPTION,
      async handler(invocation: CommandInvocation) {
        const agent = invocation.agent;
        const cwd = sessionCwd(agent);
        if (cwd === undefined) {
          return { kind: "error", text: "This session has no working directory, so there is no repository to use." };
        }

        const git = gitClient(runtime.runner, cwd);
        const result = await completeFlow(depsFor(runtime, agent, git, invocation.signal));
        if (result.kind === "merged") {
          runtime.state.invalidateRepos();
          await runtime.state.refresh(git, agent, runtime.config);
        }
        return reportComplete(result);
      },
    }),
  ];

  return () => {
    for (const dispose of disposers) dispose();
  };
}
