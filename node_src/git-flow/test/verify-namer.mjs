// The committed check for turning a namer's answer into a branch name.
//
// This is the boundary where text produced by a model becomes a git ref, so it is
// the one place in the plugin that must not trust its input. A branch name reaches
// `git` as an argv element and a worktree path as a path segment; the slug rule is
// what guarantees it can only ever be `[a-z0-9-]`, and `stripPrefixWord` is what
// keeps a reasonable answer from becoming `feature/feature-…`.
//
// The candidates below are the shapes a model actually produces when asked for a
// short identifier and told not to decorate it: it decorates it anyway, labels it,
// explains it, or answers with the prefix already attached.
//
// What a green run does NOT mean: there is no model here, so nothing proves what a
// real one answers. This checks the fence around the answer, not the answer.
import assert from "node:assert/strict";
import { slugFromCandidate, stripPrefixWord, namingPrompt, NAMING_SYSTEM } from "../lib/namer.js";
import { createModelNamer } from "../lib/runtime.js";

let passed = 0;
const failures = [];

/**
 * Run one named case, reporting rather than throwing so every case is attempted.
 *
 * @param {string} name - what the case proves.
 * @param {() => Promise<void> | void} body - the case, which asserts for itself.
 */
async function verify(name, body) {
  try {
    await body();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.log(`FAIL  ${name}\n      ${error.message.split("\n").join("\n      ")}`);
  }
}

/** Assert that a candidate slugifies to an expected value. */
function expectSlug(candidate, expected) {
  assert.equal(slugFromCandidate(candidate), expected, `candidate ${JSON.stringify(candidate)}`);
}

// --- the model half -------------------------------------------------------------
//
// This half had no coverage until a real session failed on it: the naming call was
// made with a budget smaller than the model needed to think, the answer came back
// empty, and nothing anywhere said so. The fake host below is what makes the call
// observable without a harness, and the assertions on `maxTokens` and on the
// absence of `sessionId` pin the two decisions that are not visible from outside.

/** A host that answers with the given chunks, recording the options it was called with. */
function fakeHost(chunks, { throwInstead = false, selection = { provider: "p", model: "m" } } = {}) {
  const calls = [];
  return {
    calls,
    llm: {
      stream(options) {
        calls.push(options);
        return (async function* () {
          if (throwInstead) throw new Error("adapter exploded");
          for (const chunk of chunks) yield chunk;
        })();
      },
    },
    agentDefaultModel: { currentSelection: () => selection },
  };
}

/** An agent whose session has no logged request route, so the default model is used. */
function fakeAgent() {
  return {
    session: {
      id: "s1",
      header: { cwd: "/tmp" },
      deriveMessages: () => [],
      requestHeader: () => undefined,
    },
  };
}

/** Collect the warnings a namer reports, so a silent failure cannot pass. */
function recorder() {
  const infos = [];
  const warnings = [];
  return { infos, warnings, info: (m) => infos.push(m), warn: (m) => warnings.push(m) };
}

await verify("returns the model's answer and reports which model gave it", async () => {
  const host = fakeHost([
    { type: "text-delta", index: 0, text: "git-flow-" },
    { type: "text-delta", index: 0, text: "plugin" },
    { type: "finish", reason: { kind: "stop" } },
  ]);
  const log = recorder();
  const namer = createModelNamer(host, fakeAgent(), undefined, log);

  assert.deepEqual(await namer("实现 git 工作流插件"), { kind: "named", candidate: "git-flow-plugin" });
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].provider, "p");
  assert.equal(host.calls[0].model, "m");
  assert.equal(host.calls[0].system, NAMING_SYSTEM);
  assert.equal(log.warnings.length, 0, `a success must not warn: ${log.warnings.join("; ")}`);
  assert.equal(log.infos.length, 1);
});

await verify("asks for no reasoning, because naming needs none", async () => {
  // The bug this pins, observed as `finish: max-tokens` with no text at all: a
  // reasoning model spends the whole allowance thinking and is cut off before it
  // emits a character. The adapter disables thinking only for `purpose:
  // 'session-title'`, which this call is not, so it has to ask — and the ask has to
  // be the documented id, not a guess.
  const host = fakeHost([{ type: "text-delta", index: 0, text: "x" }]);
  const log = recorder();
  await createModelNamer(host, fakeAgent(), undefined, log)("some intent");
  assert.equal(host.calls[0].reasoningEffort, "off", "the naming call must disable reasoning");
  assert.equal(host.calls[0].maxTokens, 64, "and keep the harness's own budget for the answer");
  assert.equal(host.calls.length, 1, "a first attempt that works must not be retried");
});

await verify("drops the reasoning hint when an adapter will not take it", async () => {
  // Not every adapter accepts "off", and one that refuses it must not cost the
  // feature: the second attempt omits the hint entirely.
  const host = fakeHost([
    { type: "finish", reason: { kind: "error" } },
  ]);
  // The first attempt fails; the second gets a working answer.
  let call = 0;
  host.llm.stream = (options) => {
    host.calls.push(options);
    call += 1;
    return (async function* () {
      if (call === 1) throw new Error('DeepSeek does not support reasoning effort "off"');
      yield { type: "text-delta", index: 0, text: "login-redirect" };
      yield { type: "finish", reason: { kind: "stop" } };
    })();
  };
  const log = recorder();
  const attempt = await createModelNamer(host, fakeAgent(), undefined, log)("some intent");
  assert.equal(attempt.kind, "named");
  assert.equal(attempt.candidate, "login-redirect");
  assert.equal(host.calls.length, 2, "the retry must happen exactly once");
  assert.equal(host.calls[0].reasoningEffort, "off", "the first attempt asks for no reasoning");
  assert.equal("reasoningEffort" in host.calls[1], false, "the retry leaves the effort to the model");
});

await verify("does not ask the checkpoint policy to flush the session log", async () => {
  // `sessionId` is what makes `dsh-session-checkpoint-policy` flush the durable log
  // before dispatch. That is a real side effect, on the pre-write path, for a call
  // whose whole answer is two words.
  const host = fakeHost([{ type: "text-delta", index: 0, text: "x" }]);
  await createModelNamer(host, fakeAgent())("some intent");
  assert.equal("sessionId" in host.calls[0], false, "the naming call must not carry a sessionId");
});

await verify("says why an empty answer was empty", async () => {
  const log = recorder();
  const truncated = fakeHost([{ type: "finish", reason: { kind: "max-tokens" } }]);
  assert.equal((await createModelNamer(truncated, fakeAgent(), undefined, log)("intent")).kind, "unnamed");
  assert.ok(log.warnings.length > 0, "an unusable answer must be reported, not swallowed");
  assert.ok(
    log.warnings.some((warning) => warning.includes("max-tokens")),
    `a warning must name the finish reason, got: ${log.warnings.join(" | ")}`,
  );
});

await verify("carries the reason on the attempt, for callers that cannot see a log", async () => {
  // The harness logger is not visible on every surface a plugin runs on, so the
  // reason has to travel in the one channel that always is — the message the
  // caller shows. This is what made a silent failure diagnosable.
  const truncated = fakeHost([{ type: "finish", reason: { kind: "max-tokens" } }]);
  const attempt = await createModelNamer(truncated, fakeAgent())("intent");
  assert.equal(attempt.kind, "unnamed");
  assert.ok(attempt.reason.includes("max-tokens"), `got: ${attempt.reason}`);

  const unrouted = fakeHost([], { selection: { provider: "", model: "" } });
  const noRoute = await createModelNamer(unrouted, fakeAgent())("intent");
  assert.equal(noRoute.kind, "unnamed");
  assert.ok(noRoute.reason.includes("no model route"), `got: ${noRoute.reason}`);
});

await verify("reports a failing provider instead of looking like a model with no opinion", async () => {
  const log = recorder();
  const broken = fakeHost([], { throwInstead: true });
  assert.equal((await createModelNamer(broken, fakeAgent(), undefined, log)("intent")).kind, "unnamed");
  assert.ok(
    log.warnings.some((warning) => warning.includes("adapter exploded")),
    `got: ${log.warnings.join(" | ")}`,
  );
});

await verify("reports a missing route rather than failing quietly", async () => {
  const log = recorder();
  const unrouted = fakeHost([{ type: "text-delta", index: 0, text: "x" }], { selection: { provider: "", model: "" } });
  assert.equal((await createModelNamer(unrouted, fakeAgent(), undefined, log)("intent")).kind, "unnamed");
  assert.ok(
    log.warnings.some((warning) => warning.includes("no model route")),
    `got: ${log.warnings.join(" | ")}`,
  );
  assert.equal(unrouted.calls.length, 0, "no call may be made without a route");
});

await verify("prefers the session's own logged route over the configured default", async () => {
  // A human who switched model mid-session should be named by the model they chose,
  // not by the deployment default.
  const host = fakeHost([{ type: "text-delta", index: 0, text: "x" }], { selection: { provider: "default", model: "default" } });
  const agent = fakeAgent();
  agent.session.requestHeader = () => ({ config: { provider: "chosen", model: "chosen-model" } });
  await createModelNamer(host, agent)("some intent");
  assert.equal(host.calls[0].provider, "chosen");
  assert.equal(host.calls[0].model, "chosen-model");
});

console.log("intent namer");

await verify("accepts a bare slug", () => {
  expectSlug("git-flow-plugin", "git-flow-plugin");
});

await verify("absorbs the decoration a model adds anyway", () => {
  expectSlug("`git-flow-plugin`", "git-flow-plugin");
  expectSlug('"git-flow-plugin"', "git-flow-plugin");
  expectSlug("**git-flow-plugin**", "git-flow-plugin");
  expectSlug("git-flow-plugin.", "git-flow-plugin");
});

await verify("absorbs a labelled answer", () => {
  expectSlug("Branch name: git-flow-plugin", "git-flow-plugin");
  expectSlug("name = git-flow-plugin", "git-flow-plugin");
});

await verify("takes the name and ignores the explanation after it", () => {
  expectSlug("git-flow-plugin\n\nThis describes the plugin that names branches.", "git-flow-plugin");
});

await verify("never returns anything outside the slug alphabet", () => {
  // The property that makes the result safe to pass to git and to a path join: a
  // model answer full of punctuation, slashes and quotes cannot survive.
  for (const candidate of [
    "feature/login redirect!",
    "$(rm -rf /) && echo pwned",
    "../../etc/passwd",
    "feat: add the thing (see #123)",
  ]) {
    const slug = slugFromCandidate(candidate);
    assert.ok(
      slug === undefined || /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug),
      `${JSON.stringify(candidate)} produced a slug outside the alphabet: ${JSON.stringify(slug)}`,
    );
  }
});

await verify("refuses to build a name out of a sentence", () => {
  // The model declining is the interesting case: its words slugify perfectly well,
  // so only the *shape* of the answer separates a name from an excuse.
  expectSlug("I am not sure what to call this.", undefined);
  expectSlug("I cannot determine a name from this information.", undefined);
  expectSlug("There is not enough context to name this branch.", undefined);
  // A short answer is still a name, with or without hyphens.
  expectSlug("login redirect", "login-redirect");
  expectSlug("login-redirect", "login-redirect");
});

await verify("reports nothing usable as undefined rather than inventing one", () => {
  expectSlug(undefined, undefined);
  expectSlug("", undefined);
  expectSlug("   ", undefined);
  expectSlug("\n\n", undefined);
  // Prose with no alphanumerics at all: nothing can be named from it.
  expectSlug("!!!", undefined);
});

await verify("does not repeat the branch prefix the model already included", () => {
  assert.equal(stripPrefixWord("feature-login-redirect", "feature/"), "login-redirect");
  assert.equal(stripPrefixWord("login-redirect", "feature/"), "login-redirect");
  // Never strip a name into nothing: a poor name still beats asking twice.
  assert.equal(stripPrefixWord("feature", "feature/"), "feature");
  assert.equal(stripPrefixWord("features-login", "feature/"), "features-login");
});

await verify("the prompt asks for the properties the slug rules need", () => {
  // The prompt and the parser are one contract: the parser can only be lenient
  // because the prompt asks for a small, plain answer.
  assert.ok(namingPrompt("some intent").includes("some intent"), "the intent must reach the model");
  assert.ok(/kebab-case/i.test(namingPrompt("x")), "the alphabet must be stated");
  assert.ok(/mentioned in passing/i.test(namingPrompt("x")), "the incidental-word rule must be stated");
  assert.ok(/No quotes, no backticks/i.test(namingPrompt("x")), "decoration must be forbidden");
  assert.ok(NAMING_SYSTEM.length > 0, "a system slot must be supplied");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
