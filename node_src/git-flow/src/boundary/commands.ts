/**
 * The slash commands: their definitions, and the handlers that do the work.
 *
 * One export — {@link GIT_FLOW_COMMANDS}. A wiring module iterates it, registers
 * each entry with the harness exactly as it stands, and never needs to know which
 * commands exist, what they are called, or how many there are:
 *
 * ```ts
 * for (const command of GIT_FLOW_COMMANDS) {
 *   ctx.effect(() => ctx.commands.register({ ...command.descriptor, handler: command.handler }));
 * }
 * ```
 *
 * ## Why a handler takes the invocation and nothing else
 *
 * A handler is `(invocation) => CommandResult`, which is precisely the shape the
 * command registry calls, so an entry registers with no adapter. Everything a
 * handler needs is *in* the invocation:
 *
 * - the human's text is `invocation.rawInput` (the whole point of a command);
 * - the session is `invocation.agent`, and from it come the working directory,
 *   the family key (the topmost session of the delegation chain) and the
 *   process-wide services this plugin runs on;
 * - cancellation is `invocation.signal`.
 *
 * No handler therefore takes a repository, a session, a runner or a sweep scope
 * as a parameter, and none of them is stored anywhere: a parameter list that
 * repeats what the invocation already carries is a second source of truth, and a
 * module-level copy of it is one session's facts leaking into another's command.
 *
 * ## What a command is allowed to decide
 *
 * A command is the human's shortcut, not the workflow's brain. Everything that
 * needs judgement — what a feature is called, what the merge message should say,
 * what to do about a branch that is not a descendant of `master` — is injected
 * as context for the model and finished through the tool form of the same
 * operation, which can be called again. A handler that started guessing here
 * would be guessing exactly where a model is available and a human is watching.
 *
 * ## What this file does not own
 *
 * The session walk, the argument checks and the branch prefix are in `shared`,
 * because the tool door needs the same three; this file only decides what to do
 * with them. Naming a feature from a conversation, or wording a merge message,
 * are decisions it deliberately leaves to the model.
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` and `platform` are both fair game — and
 * never upward: nothing below this layer may import it.
 *
 * @module @dsh-external/dotdsh-git-flow/commands
 */

import type { CommandDescriptor, CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { boundContextSummary } from "@deepseek-ai/dsh-llm";
import { gitClean, gitComplete, gitStart } from "../core/core.js";
import {
  factsFor,
  isValidBranchName,
  resumableSessionIds,
  sessionAgentOf,
  withBranchPrefix,
} from "./shared.js";
import { GIT_FLOW_SKILL_NAMES } from "./skill.js";

/** One command this file defines: what the composer shows, and what runs it. */
interface GitFlowCommand {
  /** Name, summary and argument hint. */
  readonly descriptor: CommandDescriptor;
  /** The registry's own handler shape, so an entry registers as it stands. */
  readonly handler: (invocation: CommandInvocation) => Promise<CommandResult>;
}

/**
 * Hand one piece of context to the model.
 *
 * The context is text, and delivery is this function's whole job: it becomes a
 * plugin-sourced message on the session and wakes it, so the model reads the
 * instruction and acts on it without the human typing anything else. Called by a
 * handler only where the workflow genuinely needs the model — never to narrate
 * what the human can already see in the command's own result.
 *
 * Only the command door has this. A tool call is already the model acting, so
 * {@link GIT_FLOW_TOOLS} injects nothing and answers with text instead.
 *
 * @param invocation - the command being dispatched.
 * @param text - what the model must know to continue.
 */
function injectContext(invocation: CommandInvocation, text: string): void {
  // dsh types an invocation's agent as `{ id }`, while the live AgentLoop object
  // behind it is what can reach the session: a command runs outside any turn, so
  // nothing else here is able to hand the model a message. Only the one member
  // used is named, and no harness agent type is imported to say so.
  const agent = invocation.agent as unknown as {
    followup(message: {
      readonly id: string;
      readonly role: "user";
      readonly content: readonly { readonly type: "text"; readonly text: string }[];
      readonly source: {
        readonly kind: "plugin";
        readonly plugin: string;
        readonly form: "notice";
        readonly summary: string;
      };
    }): void;
  };

  // `followup` rather than `steer` or `inject`: the session a command is dispatched
  // to is normally idle, and this has to open the turn that reads the context.
  agent.followup({
    // The command's own pairing id, so one run's context can be told from the
    // next run's — and from a message the human actually typed.
    id: invocation.commandId,
    role: "user",
    content: [{ type: "text", text }],
    source: {
      kind: "plugin",
      // The name `index.ts` exports. Importing it would point this file at its
      // own composition root, so the literal is repeated instead.
      plugin: "git-flow",
      form: "notice",
      // A notice's summary is the line a collapsed transcript row shows, bounded
      // the way dsh bounds its own.
      summary: boundContextSummary(text),
    },
  });
}

/** The `/git-start` command, as the composer describes it. */
const GIT_START_DESCRIPTOR: CommandDescriptor = {
  name: "git-start",
  description:
    "Open a feature branch for this session, from the name you pass or from what the session is working on",
  input: { hint: "[<feature-name>]" },
};

/** The `/git-complete` command, as the composer describes it. */
const GIT_COMPLETE_DESCRIPTOR: CommandDescriptor = {
  name: "git-complete",
  description:
    "Merge this session's feature branch into master with --no-ff, remove its worktree and delete the branch",
  // Declared, unlike the previous implementation: the merge message is the
  // model's to compose, so the composer should stop and ask for one. A second
  // Enter is the price, and it is worth paying for a commit subject that says
  // what the merge did.
  input: { hint: "[<merge-message>]" },
};

/** The `/git-cleanup` command, as the composer describes it. */
const GIT_CLEANUP_DESCRIPTOR: CommandDescriptor = {
  name: "git-cleanup",
  description: "Reclaim the branches and worktrees left behind by sessions that can no longer come back",
  // Bare: its whole input is "now".
};

/**
 * `/git-start` — open a feature branch for this session.
 *
 * Which path runs depends on whether the human named the feature.
 *
 * **With a name**, the handler does the work and asks nobody:
 *
 * 1. the name is normalized by `shared.withBranchPrefix`, and `shared.isValidBranchName`
 *    refuses anything that is not a feature subject — letters, digits and dashes,
 *    starting with a letter, twenty characters at most — before a single branch is
 *    claimed or created;
 * 2. the facts and the resumable sessions both come from the agent dsh handed over;
 * 3. `core.gitStart` decides where the family works — the main tree when no other
 *    family that can still come back is in it, a worktree of its own when one is —
 *    claims it, and creates the branch and the tree;
 * 4. the workspace it returns becomes context for the model — the branch, the tree,
 *    and the instruction to load the workflow skill
 *    ({@link GIT_FLOW_SKILL_NAMES.workflow}) — because this is the session's tree
 *    from now on and every edit belongs inside it.
 *
 * **Without a name**, the handler decides nothing at all. It injects one notice —
 * load the workflow skill ({@link GIT_FLOW_SKILL_NAMES.workflow}), then judge
 * whether the conversation already names the feature, and open the branch through
 * the tool form of this same operation — and ends there. Naming a feature from a
 * conversation is exactly the judgement this file refuses to make.
 *
 * @param invocation - the dispatched command, whose `rawInput` is the name or empty.
 * @returns the result the UI renders.
 */
async function gitStartHandler(invocation: CommandInvocation): Promise<CommandResult> {
  // `rawInput` keeps the separator whitespace the parser split on, so the name is
  // what is left after trimming it.
  const requested = invocation.rawInput.trim();
  if (requested === "") {
    injectContext(
      invocation,
      `User ran \`/git-start\` without a branch name. Load the \`${GIT_FLOW_SKILL_NAMES.workflow}\` skill. ` +
        "Judge from this conversation whether the feature already has a name: if it does, use it, and if it does " +
        "not, ask the user what they are working on. Then call the `git_start` tool with the branch name. " +
        "This command names nothing by itself, so the tool call is what opens the branch.",
    );
    return {
      kind: "success",
      text: "Waiting for a branch name: the model will take it from this conversation, or ask you for one.",
    };
  }

  const agent = sessionAgentOf(invocation.agent);
  const facts = await factsFor(agent, invocation.signal);
  const branch = withBranchPrefix(requested);
  if (!(await isValidBranchName(facts.runner, facts.repoRoot, branch))) {
    return {
      kind: "error",
      text:
        `"${branch}" is not a name this plugin opens. Name the feature itself: letters, digits and dashes, ` +
        'starting with a letter, at most 20 characters, and no "/" of your own — git-flow-guard opens feat/git-flow-guard. ' +
        "Run /git-start again with a different name.",
    };
  }

  const workspace = await gitStart(
    facts.runner,
    facts.repoRoot,
    facts.sessionId,
    branch,
    resumableSessionIds(agent.getSessions()),
    invocation.signal,
  );
  injectContext(
    invocation,
    `This session now works on branch ${workspace.branch}, in the tree ${workspace.workTree}. ` +
      `Load the \`${GIT_FLOW_SKILL_NAMES.workflow}\` skill, and make every edit from here on inside that tree: ` +
      "a path into the repository's main working tree is refused by the write guard.",
  );
  return {
    kind: "success",
    text: `Opened ${workspace.branch}: this session works in ${workspace.workTree}.`,
  };
}

/**
 * `/git-complete` — merge the family's branch back and release it.
 *
 * The command owns one call and no judgement. `core.gitComplete` is re-entrant,
 * so running this twice is not an error: a family that is already finished
 * reports `nothing-to-do`, and one whose work is only partly merged picks up
 * where it stopped.
 *
 * **With a message**, it calls `core.gitComplete` and nothing else. When the call
 * reports anything but `done`, the command stops and hands the model the context
 * instead: what `core` returned — the branch that is not a descendant of
 * `master`, or the failing step with the command and git's own output — and the
 * instruction to finish through the tool form, which can ask for the replay and
 * be called again.
 *
 * **Without a message**, it does not call `core` at all. It injects the context
 * and ends, leaving the model to compose the merge message and run the tool form
 * of this same operation — the message is the model's to write, so asking it to
 * write one is the only path that does not put words in its mouth.
 *
 * Either way the command never rebases, never resolves a conflict, and never
 * retries on the model's behalf.
 *
 * @param invocation - the dispatched command, whose `rawInput` is the message or empty.
 * @returns the result the UI renders.
 */
async function gitCompleteHandler(invocation: CommandInvocation): Promise<CommandResult> {
  // Same separator whitespace as `/git-start`; a message is what is left of the
  // raw input once it is gone.
  const message = invocation.rawInput.trim();
  if (message === "") {
    injectContext(
      invocation,
      "You ran `/git-complete` without a merge message. Compose the subject from what this session did, then call the `git_complete` tool with it. This command words no message by itself, so the tool call is what merges the branch.",
    );
    return {
      kind: "success",
      text: "Waiting for a merge message: the model will compose one and finish with `git_complete`.",
    };
  }

  const facts = await factsFor(sessionAgentOf(invocation.agent), invocation.signal);
  const result = await gitComplete(facts.runner, facts.repoRoot, facts.sessionId, message, invocation.signal);

  switch (result.kind) {
    case "done":
      return {
        kind: "success",
        text: result.merged
          ? "Merged the feature branch into master and released its worktree, branch and claim."
          : "The feature branch had nothing master did not already have; released its worktree, branch and claim.",
      };
    case "nothing-to-do":
      return {
        kind: "success",
        text: "There was nothing left to do: this session's family holds no claim.",
      };
    case "not-descendant": {
      // Nothing was written, so the same instruction is both what the human sees
      // and what the model has to act on: core never rebases on anyone's behalf.
      const text = `Branch ${result.branch} is not a descendant of master, so nothing was merged. Replay it onto master first (\`git rebase --onto master <merge-base> ${result.branch}\`), then call \`git_complete\` again.`;
      injectContext(invocation, text);
      return { kind: "error", text };
    }
    case "failed": {
      // The step, the command and git's own output travel verbatim: rewording
      // either would hide the one fact the next attempt needs.
      const text = `The ${result.step} step of /git-complete failed.\nCommand: ${result.command}\nGit: ${result.error}`;
      injectContext(invocation, text);
      return { kind: "error", text };
    }
  }
}

/**
 * `/git-cleanup` — reclaim what unrecoverable sessions left behind.
 *
 * One call to `core.gitClean`. The scope is `shared.resumableSessionIds`, asked
 * for right here rather than gathered with the facts: only a sweep needs the
 * session store walked, and a sweep is rare enough that every other handler
 * paying for it would be waste. Everything outside that list loses its claim, its
 * worktree and its branch. The result says that the sweep ran — the detail of what
 * refused to go is `core`'s to report, and it reports nothing yet.
 *
 * Takes no argument: a sweep is "now". Nothing is injected either — cleanup is
 * not work the model does.
 *
 * @param invocation - the dispatched command.
 * @returns the result the UI renders.
 */
async function gitCleanupHandler(invocation: CommandInvocation): Promise<CommandResult> {
  // One view, read twice: the sweep scope and the facts both come from the agent
  // dsh handed over. Nothing is injected — cleanup is not work the model does.
  const view = sessionAgentOf(invocation.agent);
  const resumable = resumableSessionIds(view.getSessions());
  const facts = await factsFor(view, invocation.signal);
  await gitClean(facts.runner, facts.repoRoot, resumable, invocation.signal);
  return {
    kind: "success",
    text: "Swept the branches and worktrees left behind by sessions that can no longer come back.",
  };
}

/**
 * Every command this plugin registers.
 *
 * The list is the interface: a wiring module iterates it, registers each
 * descriptor with the handler beside it, and never needs to know that `git-start`
 * comes before `git-complete` or that a third name exists at all.
 */
export const GIT_FLOW_COMMANDS: readonly GitFlowCommand[] = [
  { descriptor: GIT_START_DESCRIPTOR, handler: gitStartHandler },
  { descriptor: GIT_COMPLETE_DESCRIPTOR, handler: gitCompleteHandler },
  { descriptor: GIT_CLEANUP_DESCRIPTOR, handler: gitCleanupHandler },
];
