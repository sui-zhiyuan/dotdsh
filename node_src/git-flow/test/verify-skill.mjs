/**
 * Committed checks for the bundled skills (`lib/boundary/skill.js`).
 *
 * Boundary: this proves what the provider advertises and that each body really is
 * read from the package's `assets/` directory — the module doc warns that nothing
 * type-checks the asset URL depth, so a wrong one has to fail here rather than at
 * a model's first request. It does not prove that dsh's skill registry resolved
 * the provider, nor how it ranked a project-level skill against it.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-skill
 */

import assert from "node:assert/strict";

import {
  GIT_FLOW_SKILL_NAMES,
  GIT_FLOW_SKILL_PROVIDER,
} from "../lib/boundary/skill.js";
import { check, report } from "./support.mjs";

/** The candidate the provider lists under one name, asserted to be there. */
async function candidate(name) {
  const listed = await GIT_FLOW_SKILL_PROVIDER.list({});
  const found = listed.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `the provider lists no skill named ${name}`);
  return found;
}

await check("the provider lists exactly the two bundled skills", async () => {
  const candidates = await GIT_FLOW_SKILL_PROVIDER.list({});
  assert.equal(candidates.length, 2);
  const names = candidates.map((entry) => entry.name).sort();
  assert.deepEqual(names, ["git-flow", "git-master"]);
  // The guard's refusal names GIT_FLOW_SKILL_NAMES.workflow, so the exported
  // names and the listed ones have to be the same two strings.
  assert.deepEqual(Object.values(GIT_FLOW_SKILL_NAMES).sort(), names);
  assert.equal(GIT_FLOW_SKILL_NAMES.workflow, "git-flow");
  assert.equal(GIT_FLOW_SKILL_NAMES.gitMaster, "git-master");
  for (const entry of candidates) {
    assert.equal(entry.source, "bundled");
    assert.equal(entry.provider, GIT_FLOW_SKILL_PROVIDER.name);
  }
});

await check("each candidate carries the discovery metadata a model needs", async () => {
  const candidates = await GIT_FLOW_SKILL_PROVIDER.list({});
  for (const entry of candidates) {
    assert.equal(typeof entry.description, "string");
    assert.ok(entry.description.length > 0, `${entry.name} has no description`);
    assert.equal(typeof entry.whenToUse, "string");
    assert.ok(entry.whenToUse.length > 0, `${entry.name} has no whenToUse`);
    // Human invocation is the slash commands, so the skill is model-only.
    assert.equal(entry.invocation.modelInvocable, true);
    assert.equal(entry.invocation.userInvocable, false);
  }
});

await check("the workflow body states where a session may write", async () => {
  const entry = await candidate(GIT_FLOW_SKILL_NAMES.workflow);
  const loaded = await GIT_FLOW_SKILL_PROVIDER.get(entry);
  assert.notEqual(loaded, undefined);
  assert.equal(typeof loaded.content, "string");
  assert.ok(loaded.content.length > 0, "the workflow body is empty");
  assert.ok(loaded.content.includes("Where you may write"), loaded.content.slice(0, 120));
  assert.ok(loaded.content.includes("git_start"));
  assert.equal(loaded.name, GIT_FLOW_SKILL_NAMES.workflow);
  assert.equal(loaded.source, "bundled");
  assert.equal(loaded.provider, GIT_FLOW_SKILL_PROVIDER.name);
});

await check("the git-master body carries the commit-message convention", async () => {
  const entry = await candidate(GIT_FLOW_SKILL_NAMES.gitMaster);
  const loaded = await GIT_FLOW_SKILL_PROVIDER.get(entry);
  assert.notEqual(loaded, undefined);
  assert.equal(typeof loaded.content, "string");
  assert.ok(loaded.content.includes("Conventional Commits"), loaded.content.slice(0, 120));
  assert.ok(loaded.content.includes("BREAKING CHANGE"));
  assert.equal(loaded.name, GIT_FLOW_SKILL_NAMES.gitMaster);
  assert.equal(loaded.source, "bundled");
  assert.equal(loaded.provider, GIT_FLOW_SKILL_PROVIDER.name);
});

await check("get() of a candidate the provider does not own is undefined", async () => {
  assert.equal(await GIT_FLOW_SKILL_PROVIDER.get({ name: "not-a-git-flow-skill" }), undefined);
  assert.equal(
    await GIT_FLOW_SKILL_PROVIDER.get({ name: `${GIT_FLOW_SKILL_NAMES.workflow}-copy` }),
    undefined,
  );
});

report();
