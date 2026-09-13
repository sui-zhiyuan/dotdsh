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
 * Both shapes a start can take are checked, because the door is where the model
 * first sees which one it got: a repository whose main tree nobody holds is worked
 * in place, and a family that arrives while another resumable family holds the main
 * tree is isolated in a worktree. Which one it is, is `core`'s decision — what is
 * checked here is that the answer names the tree the session really has.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-doors
 */

import assert from "node:assert/strict";
import { existsSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { GIT_FLOW_COMMANDS } from "../lib/boundary/commands.js";
import { GIT_FLOW_SKILL_NAMES } from "../lib/boundary/skill.js";
import { GIT_FLOW_TOOLS } from "../lib/boundary/tools.js";
import { ClaimStore, MAIN_WORKTREE } from "../lib/platform/claim.js";
import { check, commitFile, makeAgent, occupyMainTree, report, scratchRepo, signal } from "./support.mjs";

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

/** The claim recorded for one session, read back through the store that owns the file. */
async function storedClaim(root, session) {
  const store = await ClaimStore.open(root);
  try {
    return await store.query(session);
  } finally {
    await store.dispose();
  }
}

/** The branch a working tree has checked out. */
function checkedOut(git, cwd) {
  return git.text(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
}

/** The body of the one notice an injection check expects. */
function noticeOf(injected) {
  assert.equal(injected.length, 1, "expected exactly one injected notice");
  assert.equal(injected[0].content[0].type, "text");
  return injected[0].content[0].text;
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

await check("git_start in a free repository takes the main tree and injects nothing", async () => {
  const repo = await scratchRepo();
  try {
    const session = sessionId("tool-main");
    const { agent, injected } = makeAgent(session, repo.root);
    const text = await tool("git_start").execute({ branchName: "doors-tool" }, execution(agent));

    assert.equal(typeof text, "string");
    assert.match(text, /feat\/doors-tool/);
    assert.ok(text.includes(repo.root), `answer does not name the main tree: ${text}`);
    assert.equal(await checkedOut(repo.git, repo.root), "feat/doors-tool", "the main tree is on the branch");
    assert.equal(existsSync(worktreePath(repo.root, "doors_tool")), false, "no worktree was made");
    assert.equal((await storedClaim(repo.root, session))?.worktreeName, MAIN_WORKTREE);
    // A tool call is already the model acting, so its return value is the whole
    // channel: anything pushed into the session would be a second answer.
    assert.deepEqual(injected, []);
  } finally {
    await repo.cleanup();
  }
});

await check("git_start while another resumable family holds the main tree answers with the worktree", async () => {
  const repo = await scratchRepo();
  try {
    const session = sessionId("tool-tree");
    const holder = sessionId("tool-holder");
    await occupyMainTree(repo.root, holder);
    const { agent, injected } = makeAgent(session, repo.root, [
      { id: holder, header: {} },
      { id: session, header: { cwd: repo.root } },
    ]);

    const text = await tool("git_start").execute({ branchName: "doors-isolated" }, execution(agent));
    const workTree = worktreePath(repo.root, "doors_isolated");

    assert.ok(text.includes(workTree), `answer does not name ${workTree}: ${text}`);
    assert.equal(existsSync(workTree), true, "the worktree was not created");
    assert.equal(statSync(workTree).isDirectory(), true);
    assert.equal(await checkedOut(repo.git, workTree), "feat/doors-isolated");
    assert.equal(await checkedOut(repo.git, repo.root), "master", "the holder's checkout was not moved");
    assert.equal((await storedClaim(repo.root, session))?.worktreeName, "doors_isolated");
    assert.deepEqual(injected, []);
  } finally {
    await repo.cleanup();
  }
});

await check("git_start refuses a name that is not a feature subject and creates nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("tool-bad"), repo.root);
    for (const name of ["bad name", "test/git-flow-guard", "9lives", "under_score", "a".repeat(21)]) {
      const text = await tool("git_start").execute({ branchName: name }, execution(agent));
      const branch = `feat/${name}`;
      assert.equal(typeof text, "string");
      assert.ok(text.includes(branch), `answer does not quote ${branch}: ${text}`);
      assert.match(text, /not a name this plugin opens/);
      assert.equal(await repo.git.ok(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]), false);
      assert.deepEqual(injected, []);
    }
    assert.equal(await checkedOut(repo.git, repo.root), "master", "the main tree was never moved");
    assert.equal(existsSync(join(repo.root, ".dsh.local")), false, "a refused name claims nothing at all");
  } finally {
    await repo.cleanup();
  }
});

await check("a bare /git-start injects one notice naming the skill and opens nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-bare"), repo.root);
    const commandId = "bare-1";
    const result = await command("git-start").handler(invocation(agent, "", commandId));

    assert.equal(result.kind, "success");
    const message = injected[0];
    assert.equal(injected.length, 1);
    // The pairing id is the command's own, so one run's context can be told from
    // the next run's and from a message the human actually typed.
    assert.equal(message.id, commandId);
    assert.equal(message.role, "user");
    assert.equal(message.source.kind, "plugin");
    assert.equal(message.source.plugin, "git-flow");
    assert.equal(message.source.form, "notice");
    assert.equal(message.content[0].type, "text");
    assert.ok(message.content[0].text.includes("git_start"));
    // Naming a feature is the model's judgement but the rules are the skill's, so
    // the notice sends it there rather than restating them.
    assert.ok(
      message.content[0].text.includes(GIT_FLOW_SKILL_NAMES.workflow),
      `notice does not name the ${GIT_FLOW_SKILL_NAMES.workflow} skill: ${message.content[0].text}`,
    );
    // Nothing was created: this path must not have touched the repository at all.
    assert.equal(existsSync(join(repo.root, ".dsh.local")), false);
    assert.equal(await repo.git.text(["branch", "--list", "--format=%(refname:short)"]), "master");
  } finally {
    await repo.cleanup();
  }
});

await check("a named /git-start opens the branch in the main tree and injects where it is", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-named"), repo.root);
    const commandId = "named-1";
    const result = await command("git-start").handler(invocation(agent, "doors-named", commandId));

    assert.equal(result.kind, "success");
    assert.ok(result.text.includes("feat/doors-named"), result.text);
    assert.equal(await checkedOut(repo.git, repo.root), "feat/doors-named");
    assert.equal(existsSync(worktreePath(repo.root, "doors_named")), false, "the main tree needed no worktree");

    const text = noticeOf(injected);
    assert.equal(injected[0].id, commandId);
    assert.ok(text.includes("feat/doors-named"), text);
    assert.ok(text.includes(repo.root), text);
    assert.ok(text.includes(GIT_FLOW_SKILL_NAMES.workflow), text);
  } finally {
    await repo.cleanup();
  }
});

await check("an invalid /git-start name is an error and injects nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-bad"), repo.root);
    const result = await command("git-start").handler(invocation(agent, "test/git-flow-guard", "bad-1"));

    assert.equal(result.kind, "error");
    assert.match(result.text, /not a name this plugin opens/);
    assert.ok(result.text.includes("feat/test/git-flow-guard"), result.text);
    // There is no judgement to hand the model: the name is simply not usable.
    assert.deepEqual(injected, []);
    assert.equal(await checkedOut(repo.git, repo.root), "master");
    assert.equal(existsSync(join(repo.root, ".dsh.local")), false);
  } finally {
    await repo.cleanup();
  }
});

await check("/git-complete without a message injects and merges nothing", async () => {
  const repo = await scratchRepo();
  try {
    const { agent, injected } = makeAgent(sessionId("cmd-complete"), repo.root);
    await tool("git_start").execute({ branchName: "doors-nomerge" }, execution(agent));
    await writeFile(join(repo.root, "note.txt"), "work\n");
    await commitFile(repo.git, repo.root, "note.txt", "feat: note");

    const before = await repo.git.text(["rev-parse", "master"]);
    const result = await command("git-complete").handler(invocation(agent, "", "nomerge-1"));

    assert.equal(result.kind, "success");
    assert.ok(noticeOf(injected).includes("git_complete"));
    // The message is the model's to compose, so this path must end at the
    // injection: master unchanged, branch and tree still in place.
    assert.equal(await repo.git.text(["rev-parse", "master"]), before);
    assert.equal(await repo.git.ok(["show-ref", "--verify", "--quiet", "refs/heads/feat/doors-nomerge"]), true);
    assert.equal(await checkedOut(repo.git, repo.root), "feat/doors-nomerge");
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
