/**
 * Committed checks for the two doors into the same three operations:
 * `lib/boundary/commands.js` and `lib/boundary/tools.js`.
 *
 * Boundary: this calls each exported handler and executor with a fabricated
 * invocation or execution, against a real scratch repository and a real git. It
 * proves the descriptors both doors declare and the answers they give — text and
 * no injection from a tool, one plugin-sourced notice from a command that still
 * needs the model. It does not prove that dsh registered either list, nor how the
 * composer renders an input hint.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-doors
 */

import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GIT_FLOW_COMMANDS } from "../lib/boundary/commands.js";
import { GIT_FLOW_TOOLS } from "../lib/boundary/tools.js";
import { GitClient, nodeRunner } from "../lib/platform/exec.js";
import { check, makeAgent, report, scratchRepo, signal } from "./support.mjs";

/**
 * Session ids differ per check: `core` memoizes a family's workspace process-wide
 * by session id, so a shared id would answer across repositories.
 */
let sequence = 0;
const sessionId = (label) => `doors-${++sequence}-${label}`;

/** One command entry, asserted rather than assumed. */
function command(name) {
  const entry = GIT_FLOW_COMMANDS.find((candidate) => candidate.descriptor.name === name);
  assert.ok(entry !== undefined, `GIT_FLOW_COMMANDS exports no ${name} command`);
  return entry;
}

/** One tool entry, asserted rather than assumed. */
function tool(name) {
  const entry = GIT_FLOW_TOOLS.find((candidate) => candidate.descriptor.name === name);
  assert.ok(entry !== undefined, `GIT_FLOW_TOOLS exports no ${name} tool`);
  return entry;
}

/** The invocation the command registry hands a handler. */
const invocation = (agent, rawInput, commandId) => ({
  commandId,
  agent,
  rawInput,
  attachments: [],
  signal,
});

/** What the tool registry hands an executor. */
const execution = (agent) => ({ agent, signal });

/** The directory `core` puts a family's worktree in. */
const worktreePath = (root, name) => join(root, ".dsh.local", "worktrees", name);

/**
 * Commit one file in a worktree.
 *
 * A merge is only meaningful for a branch with a commit master does not have, so
 * the `done` outcome needs the worktree to be dirty first.
 */
async function commitIn(workTree, name) {
  await writeFile(join(workTree, name), "work\n");
  const git = new GitClient(nodeRunner, workTree);
  await git.run(["add", "-A"]);
  await git.run(["commit", "-qm", `feat: ${name}`]);
}

await check("both doors describe the same three operations", async () => {
  const commands = GIT_FLOW_COMMANDS.map((entry) => entry.descriptor.name).sort();
  const tools = GIT_FLOW_TOOLS.map((entry) => entry.descriptor.name).sort();
  assert.deepEqual(commands, ["git-cleanup", "git-complete", "git-start"]);
  assert.deepEqual(tools, ["git_cleanup", "git_complete", "git_start"]);
});

await check("git-start and git-complete declare an input hint", async () => {
  for (const name of ["git-start", "git-complete"]) {
    const { descriptor } = command(name);
    assert.equal(typeof descriptor.input?.hint, "string", `${name} declares no input hint`);
    assert.ok(descriptor.input.hint.length > 0, `${name}'s input hint is empty`);
  }
});

await check("the tools declare the arguments the model must supply", async () => {
  assert.equal(tool("git_start").descriptor.parameters.branchName?.required, true);
  assert.equal(tool("git_complete").descriptor.parameters.mergeMessage?.required, true);
  assert.deepEqual(Object.keys(tool("git_cleanup").descriptor.parameters), []);
});

await check("git_start answers with the branch and the worktree, and injects nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("tool-start"), repo.root);
    const text = await tool("git_start").execute({ branchName: "doors-tool" }, execution(agent));
    const workTree = worktreePath(repo.root, "doors_tool");
    assert.equal(typeof text, "string");
    assert.match(text, /feat\/doors-tool/);
    assert.ok(text.includes(workTree), `answer does not name ${workTree}: ${text}`);
    assert.equal(existsSync(workTree), true);
    assert.equal(statSync(workTree).isDirectory(), true);
    // A tool call is already the model acting, so its return value is the whole
    // channel: anything pushed into the session would be a second answer.
    assert.deepEqual(injected, []);
  } finally {
    await repo.cleanup();
  }
});

await check("git_start refuses a name git rejects and creates nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("tool-bad"), repo.root);
    const text = await tool("git_start").execute({ branchName: "bad name" }, execution(agent));
    assert.equal(typeof text, "string");
    assert.ok(text.includes("feat/bad name"), `answer does not quote the name: ${text}`);
    assert.match(text, /not a name git accepts/);
    assert.equal(await repo.git.ok(["show-ref", "--verify", "--quiet", "refs/heads/feat/bad name"]), false);
    assert.equal(existsSync(worktreePath(repo.root, "bad name")), false);
    assert.deepEqual(injected, []);
  } finally {
    await repo.cleanup();
  }
});

await check("git_complete answers done, then nothing-to-do, and injects nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("tool-complete"), repo.root);
    await tool("git_start").execute({ branchName: "doors-complete" }, execution(agent));
    const workTree = worktreePath(repo.root, "doors_complete");
    await commitIn(workTree, "note.txt");

    const done = await tool("git_complete").execute(
      { mergeMessage: "feat: doors complete" },
      execution(agent),
    );
    assert.equal(typeof done, "string");
    // `done` is the merge path, not the "already had those commits" wording.
    assert.match(done, /Merged the feature branch into master with --no-ff/);
    assert.match(done, /family is finished/);
    assert.equal(existsSync(workTree), false);
    assert.equal(await repo.git.ok(["show-ref", "--verify", "--quiet", "refs/heads/feat/doors-complete"]), false);

    // Re-entrancy is the contract: a family already finished must answer, not fail.
    const again = await tool("git_complete").execute(
      { mergeMessage: "feat: doors complete" },
      execution(agent),
    );
    assert.equal(typeof again, "string");
    assert.notEqual(again, done);
    assert.match(again, /No claim is recorded/);
    assert.deepEqual(injected, []);
  } finally {
    await repo.cleanup();
  }
});

await check("a bare /git-start injects one notice and opens nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-bare"), repo.root);
    const commandId = "bare-1";
    const result = await command("git-start").handler(invocation(agent, "", commandId));

    assert.equal(result.kind, "success");
    assert.equal(injected.length, 1);
    const message = injected[0];
    // The pairing id is the command's own, so one run's context can be told from
    // the next run's and from a message the human actually typed.
    assert.equal(message.id, commandId);
    assert.equal(message.role, "user");
    assert.equal(message.source.kind, "plugin");
    assert.equal(message.source.plugin, "git-flow");
    assert.equal(message.source.form, "notice");
    assert.equal(message.content[0].type, "text");
    assert.ok(message.content[0].text.includes("git_start"));
    // Nothing was created: naming a feature is the model's judgement, so this path
    // must not have touched the repository at all.
    assert.equal(existsSync(join(repo.root, ".dsh.local")), false);
    assert.equal(await repo.git.text(["branch", "--list", "--format=%(refname:short)"]), "master");
  } finally {
    await repo.cleanup();
  }
});

await check("a named /git-start opens the worktree and injects where it is", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-named"), repo.root);
    const commandId = "named-1";
    const result = await command("git-start").handler(invocation(agent, "doors-named", commandId));
    const workTree = worktreePath(repo.root, "doors_named");

    assert.equal(result.kind, "success");
    assert.ok(result.text.includes("feat/doors-named"), result.text);
    assert.equal(existsSync(workTree), true);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].id, commandId);
    const text = injected[0].content[0].text;
    assert.ok(text.includes("feat/doors-named"), text);
    assert.ok(text.includes(workTree), text);
  } finally {
    await repo.cleanup();
  }
});

await check("an invalid /git-start name is an error and injects nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-bad"), repo.root);
    const result = await command("git-start").handler(invocation(agent, "bad name", "bad-1"));

    assert.equal(result.kind, "error");
    assert.match(result.text, /will not accept/);
    // There is no judgement to hand the model: the name is simply not usable.
    assert.deepEqual(injected, []);
    assert.equal(existsSync(worktreePath(repo.root, "bad name")), false);
  } finally {
    await repo.cleanup();
  }
});

await check("/git-complete without a message injects and merges nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-complete"), repo.root);
    await tool("git_start").execute({ branchName: "doors-nomerge" }, execution(agent));
    const workTree = worktreePath(repo.root, "doors_nomerge");
    await commitIn(workTree, "note.txt");

    const before = await repo.git.text(["rev-parse", "master"]);
    const result = await command("git-complete").handler(invocation(agent, "", "nomerge-1"));

    assert.equal(result.kind, "success");
    assert.equal(injected.length, 1);
    assert.ok(injected[0].content[0].text.includes("git_complete"));
    // The message is the model's to compose, so this path must end at the
    // injection: master unchanged, branch and worktree still in place.
    assert.equal(await repo.git.text(["rev-parse", "master"]), before);
    assert.equal(await repo.git.ok(["show-ref", "--verify", "--quiet", "refs/heads/feat/doors-nomerge"]), true);
    assert.equal(existsSync(workTree), true);
  } finally {
    await repo.cleanup();
  }
});

await check("/git-cleanup injects nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-clean"), repo.root);
    const result = await command("git-cleanup").handler(invocation(agent, "", "clean-1"));

    assert.equal(result.kind, "success");
    assert.match(result.text, /Swept/);
    // Cleanup is not work the model does, so no context is pushed at it.
    assert.deepEqual(injected, []);
  } finally {
    await repo.cleanup();
  }
});

await check("every command answer is a CommandResult", async () => {
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("cmd-shape"), repo.root);
    for (const name of ["git-start", "git-complete", "git-cleanup"]) {
      const result = await command(name).handler(invocation(agent, "", `shape-${name}`));
      assert.ok(
        result.kind === "success" || result.kind === "error",
        `${name} answered kind ${String(result.kind)}`,
      );
      assert.equal(typeof result.text, "string");
    }
  } finally {
    await repo.cleanup();
  }
});

await check("git_cleanup is called with the registry's two arguments, an empty one first", async () => {
  // Every executor is invoked as `(args, execution)`, including the tool whose
  // descriptor declares no parameters. This check exists because the first version
  // of `git_cleanup` took the execution alone: the registry then handed the empty
  // argument object to that parameter and the real context was dropped, so every
  // call threw "not a live agent".
  const repo = await scratchRepo();
  try {
    const { agent } = makeAgent(sessionId("cmd-sweep"), repo.root);
    const text = await tool("git_cleanup").execute({}, { agent, signal });

    assert.equal(typeof text, "string");
    assert.match(text, /Reclaimed/);
  } finally {
    await repo.cleanup();
  }
});

report();
