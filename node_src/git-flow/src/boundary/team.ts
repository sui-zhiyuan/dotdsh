/**
 * The Team role rule: git-flow is the Lead's workflow, not a teammate's.
 *
 * A Team is one top-level session (the Lead) that delegates work to child
 * sessions, and git-flow's whole model is a *family*: one branch, one claim, one
 * tree per delegation chain, resolved to the topmost session (see `familyRoot` in
 * `shared.ts`). A teammate is already inside the Lead's family, so a `git_start`
 * from a teammate would not open "its own" branch — it would move the Lead's
 * family, and a `git_complete` would finish work the Lead may not have seen. The
 * branch workflow is therefore a Lead decision, and a teammate is refused before
 * any of it runs.
 *
 * ## How a member is recognized
 *
 * `SessionRecord.header.parentSession` is present exactly when a session was
 * delegated or forked, which is the same field `resumableSessionIds` already uses
 * to tell a human's top-level session from a subagent's. Nothing else is
 * consulted: a member is not asked to prove it, and no chain walk is needed,
 * because the session dsh hands an entry point is the caller, and the caller's own
 * header is the fact.
 *
 * ## Why this module exists separately
 *
 * Both doors call it — the tool executors and the command handlers — and they must
 * refuse with the *same* words. A rule stated twice is a rule that can disagree
 * with itself, and the text is the whole answer a teammate gets: it has to name
 * the action it was trying and the exact `send_message` that asks the Lead to do
 * it instead.
 *
 * ## Layer
 *
 * The boundary, beside `shared.ts` and below both doors. It reads a session and
 * returns text; it runs nothing and touches no service. `core` and `platform`
 * never see it.
 *
 * @module @dsh-external/dotdsh-git-flow/team
 */

import type { SessionRecord } from "./shared.js";

/** The three operations a teammate can be refused. */
export type GitFlowAction = "start" | "complete" | "cleanup";

/**
 * The command that performs each action, as the refusal spells it for the Lead.
 *
 * Written out rather than derived from the tool names: what a teammate sends the
 * Lead is a slash command, and the tool form takes structured arguments no
 * `send_message` can carry.
 */
const ACTION_COMMANDS: Readonly<Record<GitFlowAction, string>> = {
  start: "/git-start <feature-name>",
  complete: "/git-complete <merge message>",
  cleanup: "/git-cleanup",
};

/**
 * Whether this session is the top of a delegation chain — a human's own session.
 *
 * The Lead is the session with no `parentSession`; every delegated child has one,
 * whether it was spawned as a subagent or forked. This is the same test
 * `resumableSessionIds` applies to decide whose claim a sweep must leave alone.
 *
 * @param session - the calling session, as dsh hands it to an entry point.
 * @returns true when this session is a top-level session.
 */
export function isTopLevelSession(session: SessionRecord): boolean {
  return session.header.parentSession === undefined;
}

/**
 * The refusal a teammate gets, or `undefined` when the caller is the Lead.
 *
 * The text is deliberately instructional rather than apologetic: the teammate
 * cannot do the thing, so the only useful answer is who can and exactly how to ask
 * them. The `send_message` line is a real tool call with the target and the
 * command filled in, because a teammate that has to compose that itself is a
 * teammate that can get it wrong.
 *
 * @param session - the calling session, as dsh hands it to an entry point.
 * @param action - which of the three operations was attempted.
 * @returns the refusal text, or `undefined` when the caller may proceed.
 */
export function leadOnlyRefusal(session: SessionRecord, action: GitFlowAction): string | undefined {
  if (isTopLevelSession(session)) return undefined;
  return [
    "git-flow is Lead-only inside a Team: a teammate cannot open or finish the feature branch.",
    "Ask your Team Lead to do it:",
    `  send_message({ target: "lead", message: "please run ${ACTION_COMMANDS[action]}" })`,
    "Then work inside the tree the Lead answers with.",
  ].join("\n");
}
