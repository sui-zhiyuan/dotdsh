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
