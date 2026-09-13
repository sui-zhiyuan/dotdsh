/**
 * Committed checks for the pre-write guard (`lib/boundary/guard.js`).
 *
 * Boundary: this drives the exported interceptor directly, with fabricated
 * executions and a continuation that records whether it ran, against a real
 * scratch repository and a real git. It proves the five rules the module header
 * states and that no input produces `ask`; it does not prove that dsh calls the
 * listener on `tools/pre-execute`, nor that the arguments a real dispatch freezes
 * are the ones asserted here.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-guard
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { GIT_FLOW_INTERCEPTOR } from "../lib/boundary/guard.js";
import { GIT_FLOW_SKILL_NAMES } from "../lib/boundary/skill.js";
import { GIT_FLOW_TOOLS } from "../lib/boundary/tools.js";
import { check, makeAgent, report, scratchRepo, signal } from "./support.mjs";

/**
 * Every check takes a session id nobody else used.
 *
 * `core` memoizes one family's resolved workspace for the whole process, keyed by
 * session id alone: a repeated id would answer from the previous check's claim —
 * or its memoized "no claim" — while reading a different repository.
 */
let sequence = 0;
const sessionId = (label) => `guard-${++sequence}-${label}`;

/**
 * Drive the guard once.
 *
 * Returns both the decision and whether the continuation ran, because "passes
 * through" is exactly that — not merely an `allow`, which is what `next()`
 * happens to return here.
 *
 * @param execution - the fabricated pending call.
 * @returns the decision and the pass-through flag.
 */
async function decide(execution) {
  let passed = false;
  const next = () => {
    passed = true;
    return Promise.resolve({ kind: "allow" });
  };
  const decision = await GIT_FLOW_INTERCEPTOR.handle(execution, next);
  return { decision, passed };
}

/** The directory `core` puts a family's worktree in. */
const worktreePath = (root, name) => join(root, ".dsh.local", "worktrees", name);

/** The `git_start` entry, asserted rather than assumed. */
function startTool() {
  const entry = GIT_FLOW_TOOLS.find((candidate) => candidate.descriptor.name === "git_start");
  assert.ok(entry !== undefined, "GIT_FLOW_TOOLS exports no git_start tool");
  return entry;
}

await check("a tool that cannot write a file passes through", async () => {
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("todo"), repo.root);
    const { decision, passed } = await decide({
      name: "todo_write",
      arguments: { todos: [] },
      agent,
      signal,
    });
    assert.equal(passed, true);
    assert.equal(decision.kind, "allow");
  } finally {
    await repo.cleanup();
  }
});

await check("a read tool passes through", async () => {
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("read"), repo.root);
    const { decision, passed } = await decide({
      name: "read",
      arguments: { file_path: join(repo.root, "README.md") },
      agent,
      signal,
    });
    assert.equal(passed, true);
    assert.equal(decision.kind, "allow");
  } finally {
    await repo.cleanup();
  }
});

await check("str_replace_editor view passes through", async () => {
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("view"), repo.root);
    const { decision, passed } = await decide({
      name: "str_replace_editor",
      arguments: { command: "view", path: join(repo.root, "README.md") },
      agent,
      signal,
    });
    assert.equal(passed, true);
    assert.equal(decision.kind, "allow");
  } finally {
    await repo.cleanup();
  }
});

await check("a mutating str_replace_editor sub-command is checked, not waved through", async () => {
  // The tool name alone says nothing about read or write, so the sub-command is
  // the whole question: a view is skipped, anything else must reach the claim.
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("str-replace"), repo.root);
    const { decision, passed } = await decide({
      name: "str_replace_editor",
      arguments: {
        command: "str_replace",
        path: join(repo.root, "README.md"),
        old_str: "base",
        new_str: "changed",
      },
      agent,
      signal,
    });
    assert.equal(passed, false);
    assert.equal(decision.kind, "deny");
  } finally {
    await repo.cleanup();
  }
});

await check("a call that carries no agent passes through", async () => {
  // The harness sets an agent only for what the agent loop dispatches, so an
  // execution without one is not a session's call and cannot be judged.
  const repo = await scratchRepo();
  try {
    const { decision, passed } = await decide({
      name: "write",
      arguments: { file_path: join(repo.root, "orphan.txt") },
      signal,
    });
    assert.equal(passed, true);
    assert.equal(decision.kind, "allow");
  } finally {
    await repo.cleanup();
  }
});

await check("a write outside the repository passes through", async () => {
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("outside"), repo.root);
    const { decision, passed } = await decide({
      name: "write",
      arguments: { file_path: resolve(repo.root, "..", "elsewhere.txt") },
      agent,
      signal,
    });
    assert.equal(passed, true);
    assert.equal(decision.kind, "allow");
  } finally {
    await repo.cleanup();
  }
});

await check("a write into the repository with no claim is refused, naming the skill and git_start", async () => {
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("no-claim"), repo.root);
    const { decision, passed } = await decide({
      name: "write",
      arguments: { file_path: join(repo.root, "note.txt") },
      agent,
      signal,
    });
    assert.equal(passed, false);
    assert.equal(decision.kind, "deny");
    assert.equal(typeof decision.reason, "string");
    // The skill name comes from the module the guard imports, so a rename cannot
    // leave the refusal pointing at a skill that no longer exists.
    assert.ok(
      decision.reason.includes(GIT_FLOW_SKILL_NAMES.workflow),
      `refusal does not name the ${GIT_FLOW_SKILL_NAMES.workflow} skill: ${decision.reason}`,
    );
    assert.ok(
      decision.reason.includes("git_start"),
      `refusal does not tell the model to call git_start: ${decision.reason}`,
    );
  } finally {
    await repo.cleanup();
  }
});

await check("inside a claimed worktree a write is allowed, and a main-tree write is redirected", async () => {
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("claimed"), repo.root);
    await startTool().execute({ branchName: "guard-claim" }, { agent, signal });
    const workTree = worktreePath(repo.root, "guard_claim");
    assert.equal(existsSync(workTree), true, "the claim was not materialized into a worktree");

    const inside = await decide({
      name: "edit",
      arguments: { file_path: join(workTree, "note.txt"), old_string: "a", new_string: "b" },
      agent,
      signal,
    });
    assert.equal(inside.passed, true);
    assert.equal(inside.decision.kind, "allow");

    const outside = await decide({
      name: "write",
      arguments: { file_path: join(repo.root, "note.txt") },
      agent,
      signal,
    });
    assert.equal(outside.passed, false);
    assert.equal(outside.decision.kind, "deny");
    // The model cannot derive where its family was put, so the refusal has to
    // spell the redirected path out; without it the refusal is a dead end.
    const redirected = join(workTree, "note.txt");
    assert.ok(
      outside.decision.reason.includes(redirected),
      `refusal does not name the redirected path ${redirected}: ${outside.decision.reason}`,
    );
    assert.ok(
      outside.decision.reason.includes(workTree),
      `refusal does not name the worktree ${workTree}: ${outside.decision.reason}`,
    );
    assert.ok(outside.decision.reason.includes(GIT_FLOW_SKILL_NAMES.workflow));
  } finally {
    await repo.cleanup();
  }
});

await check("the guard never answers ask", async () => {
  // One repository, two families and a spread of inputs: the reader of a refusal
  // is the model, never a human, so an `ask` anywhere would be a proof that the
  // guard tried to consult one.
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("ask-claimed"), repo.root);
    await startTool().execute({ branchName: "ask-spread" }, { agent, signal });
    const workTree = worktreePath(repo.root, "ask_spread");
    const stranger = makeAgent(sessionId("ask-stranger"), repo.root).agent;

    const calls = [
      { name: "write", arguments: { file_path: join(repo.root, "a.txt") }, agent: stranger, signal },
      { name: "write", arguments: { file_path: join(workTree, "a.txt") }, agent, signal },
      { name: "write", arguments: { file_path: join(repo.root, "a.txt") }, agent, signal },
      { name: "bash", arguments: { command: "rm -rf /" }, agent, signal },
      {
        name: "str_replace_editor",
        arguments: { command: "view", path: join(repo.root, "README.md") },
        agent,
        signal,
      },
      { name: "write", arguments: { file_path: join(repo.root, "a.txt") }, signal },
    ];

    for (const call of calls) {
      const { decision } = await decide(call);
      assert.ok(
        decision.kind === "allow" || decision.kind === "deny",
        `${call.name} answered ${String(decision.kind)}`,
      );
    }
  } finally {
    await repo.cleanup();
  }
});

report();
