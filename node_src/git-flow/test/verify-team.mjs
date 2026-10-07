/**
 * Committed checks for the Team role rule: git-flow is Lead-only.
 *
 * Boundary: a Team's top-level session (the Lead) keeps the whole workflow, while
 * a delegated member is refused by both doors before anything runs. This file
 * drives each exported tool executor and command handler with a fabricated agent —
 * one whose session has no `parentSession`, one whose session has it — against a
 * real scratch repository, and proves the two properties that matter:
 *
 * - the refusal is the answer (a tool's text, a command's `error` result), names
 *   the action it was trying, and carries the exact `send_message` that asks the
 *   Lead to do it instead; and
 * - nothing happened: no git child was spawned, no claim file was written, the
 *   checkout never moved, and a command injected no context.
 *
 * What a green run does NOT prove: that dsh's Agent Teams feature really marks a
 * delegated session with `header.parentSession` (that is dsh's session model, and
 * `resumableSessionIds` already relies on the same field), nor that a real Team's
 * Lead is reachable by the `send_message` the refusal shows — only that the text
 * says so and the doors stop there.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-team
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { GIT_FLOW_COMMANDS } from "../lib/boundary/commands.js";
import { leadOnlyRefusal } from "../lib/boundary/team.js";
import { GIT_FLOW_TOOLS } from "../lib/boundary/tools.js";
import { check, makeAgent, report, scratchRepo, settings, signal } from "./support.mjs";

/** The settings every door here runs with: the shipped defaults. */
const SETTINGS = settings();

/** The one command entry for a name, asserted rather than assumed. */
function command(name) {
  const entry = GIT_FLOW_COMMANDS.find((candidate) => candidate.descriptor.name === name);
  assert.ok(entry !== undefined, `GIT_FLOW_COMMANDS exports no ${name} command`);
  return entry;
}

/** The one tool entry for a name, asserted rather than assumed. */
function tool(name) {
  const entry = GIT_FLOW_TOOLS.find((candidate) => candidate.descriptor.name === name);
  assert.ok(entry !== undefined, `GIT_FLOW_TOOLS exports no ${name} tool`);
  return entry;
}

/** The invocation the command registry hands a handler. */
const invocation = (agent, rawInput, commandId) => ({ commandId, agent, rawInput, attachments: [], signal });

/** What the tool registry hands an executor. */
const execution = (agent) => ({ agent, signal });

/** The refusal text one action must produce, spelled out here rather than imported. */
const refusalFor = (commandText) =>
  [
    "git-flow is Lead-only inside a Team: a teammate cannot open or finish the feature branch.",
    "Ask your Team Lead to do it:",
    `  send_message({ target: "lead", message: "please run ${commandText}" })`,
    "Then work inside the tree the Lead answers with.",
  ].join("\n");

/**
 * A member agent: a session with `header.parentSession` pointing at a resident Lead.
 *
 * The Lead is listed as resident too, so the member is refused by its own header
 * and not merely because a walk found nothing above it.
 *
 * @param root - the scratch repository's main tree.
 * @param label - a per-check suffix, so session ids do not collide across checks.
 * @returns the agent, the spawn record and the injection list.
 */
function memberAgent(root, label) {
  const lead = `team-lead-${label}`;
  const member = `team-member-${label}`;
  return makeAgent(member, root, [
    { id: lead, header: { cwd: root } },
    { id: member, header: { cwd: root, parentSession: lead } },
  ]);
}

// ------------------------------------------------------------ the predicate itself
await check("the predicate reads the caller's own header", async () => {
  assert.equal(leadOnlyRefusal({ id: "lead", header: {} }, "start"), undefined);
  const member = { id: "member", header: { parentSession: "lead" } };
  for (const [action, commandText] of [
    ["start", "/git-start <feature-name>"],
    ["complete", "/git-complete <merge message>"],
    ["cleanup", "/git-cleanup"],
  ]) {
    assert.equal(leadOnlyRefusal(member, action), refusalFor(commandText), `${action} refusal`);
  }
  // A parent that is no longer resident does not make the member a Lead: the
  // caller's own header is the fact, exactly as `resumableSessionIds` reads it.
  assert.notEqual(leadOnlyRefusal({ id: "member", header: { parentSession: "gone" } }, "start"), undefined);
});

// --------------------------------------------------------------- the Lead is untouched
await check("a Lead session's tools still run the workflow", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, spawns, injected } = makeAgent("team-lead-tools", repo.root);
    const text = await tool("git_start").execute({ branchName: "team-lead" }, execution(agent), SETTINGS);

    assert.match(text, /feat\/team-lead/, text);
    assert.ok(text.includes(repo.root), `answer does not name the main tree: ${text}`);
    assert.ok(spawns.length > 0, "the Lead path really started git");
    assert.equal(existsSync(join(repo.root, ".dsh.local")), true, "the Lead's call claimed its tree");
    assert.deepEqual(injected, [], "a tool never injects");
  } finally {
    await repo.cleanup();
  }
});

await check("a Lead session's commands still answer normally", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent("team-lead-commands", repo.root);

    // The bare paths are the ones the member check sits in front of, so they are
    // exactly what has to keep working for the Lead.
    const bareStart = await command("git-start").handler(invocation(agent, "", "lead-start"), SETTINGS);
    assert.equal(bareStart.kind, "success");
    assert.equal(injected.length, 1, "the Lead still gets the naming notice");

    const bareComplete = await command("git-complete").handler(invocation(agent, "", "lead-complete"), SETTINGS);
    assert.equal(bareComplete.kind, "success");
    assert.equal(injected.length, 2, "the Lead still gets the merge-message notice");

    const cleanup = await command("git-cleanup").handler(invocation(agent, "", "lead-clean"), SETTINGS);
    assert.equal(cleanup.kind, "success");
    assert.match(cleanup.text, /Swept/);
  } finally {
    await repo.cleanup();
  }
});

// ------------------------------------------------------------ the member is refused
await check("a member's three tool calls are refused, with no git and no claim", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, spawns, injected } = memberAgent(repo.root, "tools");

    for (const [name, args, commandText] of [
      ["git_start", { branchName: "team-member" }, "/git-start <feature-name>"],
      ["git_complete", { mergeMessage: "feat: member work" }, "/git-complete <merge message>"],
      ["git_cleanup", {}, "/git-cleanup"],
    ]) {
      const text = await tool(name).execute(args, execution(agent), SETTINGS);
      assert.equal(text, refusalFor(commandText), `${name} must answer with the refusal`);
    }

    assert.equal(spawns.length, 0, "a refused tool call started no git child");
    assert.deepEqual(injected, [], "a refused tool call injects nothing");
    assert.equal(existsSync(join(repo.root, ".dsh.local")), false, "a refused tool call wrote no claim");
    assert.equal(await repo.git.text(["--no-pager", "branch", "--list", "--format=%(refname:short)"]), "master");
    assert.equal(await repo.git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master");
  } finally {
    await repo.cleanup();
  }
});

await check("a member's three commands are refused, with no git, no claim and no notice", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, spawns, injected } = memberAgent(repo.root, "commands");

    // Both shapes of start and complete are checked: the refusal has to precede
    // the bare path, which is where a command would otherwise inject context.
    for (const [name, rawInput, commandText] of [
      ["git-start", "team-member", "/git-start <feature-name>"],
      ["git-start", "", "/git-start <feature-name>"],
      ["git-complete", "feat: member work", "/git-complete <merge message>"],
      ["git-complete", "", "/git-complete <merge message>"],
      ["git-cleanup", "", "/git-cleanup"],
    ]) {
      const result = await command(name).handler(invocation(agent, rawInput, `member-${name}-${rawInput.length}`), SETTINGS);
      assert.equal(result.kind, "error", `${name} must be refused`);
      assert.equal(result.text, refusalFor(commandText), `${name} must answer with the refusal`);
      assert.ok(result.text.includes('send_message({ target: "lead"'), result.text);
      assert.ok(result.text.includes("Then work inside the tree the Lead answers with."), result.text);
    }

    assert.equal(spawns.length, 0, "a refused command started no git child");
    assert.deepEqual(injected, [], "a refused command injected no context");
    assert.equal(existsSync(join(repo.root, ".dsh.local")), false, "a refused command wrote no claim");
    assert.equal(await repo.git.text(["--no-pager", "branch", "--list", "--format=%(refname:short)"]), "master");
    assert.equal(await repo.git.text(["rev-parse", "--abbrev-ref", "HEAD"]), "master");
  } finally {
    await repo.cleanup();
  }
});

report();
