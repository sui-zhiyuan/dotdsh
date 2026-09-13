/**
 * Committed checks for the plugin's configuration (`lib/platform/settings.js`).
 *
 * Everything below the boundary runs on what this module returns: a wrong default,
 * a value that slips through validation, or a path that escapes the repository is a
 * misconfiguration that would otherwise surface as a strange failure several layers
 * down. So the checks below pin the defaults, the normalization a row's spelling may
 * need, and one refusal per setting — each naming the key it refused.
 *
 * Boundary: this proves the resolution rules, not that dsh composed the row this
 * plugin asked for, and not that the schema in `index.ts` and these defaults agree
 * — the schema reads its `.default` from `DEFAULT_FLOW_SETTINGS`, and only a boot
 * settles what a real row does.
 *
 * @module @dsh-external/dotdsh-git-flow/test/verify-settings
 */

import assert from "node:assert/strict";

import { DEFAULT_FLOW_SETTINGS, resolveSettings } from "../lib/platform/settings.js";
import { check, report } from "./support.mjs";

/**
 * The message of the refusal a row is expected to earn.
 *
 * @param input - the row configuration to resolve.
 * @returns the error message, once the refusal is confirmed to be an `Error`.
 */
function refusal(input) {
  try {
    resolveSettings(input);
  } catch (error) {
    assert.ok(error instanceof Error, "a refusal must be an Error");
    return error.message;
  }
  throw new Error(`expected ${JSON.stringify(input)} to be refused`);
}

await check("a row that says nothing gets the shipped defaults", async () => {
  assert.deepEqual(resolveSettings({}), DEFAULT_FLOW_SETTINGS);
  // The default is a value, not a shape: resolving it twice must not hand back the
  // same object, or a caller could edit the defaults for everyone.
  assert.notEqual(resolveSettings({}), DEFAULT_FLOW_SETTINGS);
});

await check("a row's values survive resolution, normalized where a spelling varies", async () => {
  const settings = resolveSettings({
    branchPrefix: "feature",
    integrationBranch: "trunk",
    worktreeRoot: "state/trees/",
    claimFile: "state/claims.toml/",
    lockStaleSeconds: 30,
    sweepAgeHours: 2,
    branchSubjectMaxLength: 32,
    guard: "off",
  });
  assert.deepEqual(settings, {
    branchPrefix: "feature/",
    integrationBranch: "trunk",
    worktreeRoot: "state/trees",
    claimFile: "state/claims.toml",
    lockStaleSeconds: 30,
    sweepAgeHours: 2,
    branchSubjectMaxLength: 32,
    guard: "off",
  });
  // A prefix already carrying its slash is left alone rather than doubled.
  assert.equal(resolveSettings({ branchPrefix: "feat/" }).branchPrefix, "feat/");
  assert.equal(resolveSettings({ branchPrefix: "feat//" }).branchPrefix, "feat/");
});

await check("a branch prefix git could not take is refused by name", async () => {
  for (const branchPrefix of ["", "/", "feat name", "-feat", "feat..x", "feat~1", "feat//x", "feat."]) {
    assert.match(
      refusal({ branchPrefix }),
      /branchPrefix/,
      `branchPrefix ${JSON.stringify(branchPrefix)} should have been refused`,
    );
  }
});

await check("an integration branch that is not a branch name is refused by name", async () => {
  for (const integrationBranch of ["", "main branch", "-main", "main/", "main.", "a..b"]) {
    assert.match(
      refusal({ integrationBranch }),
      /integrationBranch/,
      `integrationBranch ${JSON.stringify(integrationBranch)} should have been refused`,
    );
  }
});

await check("a path setting that escapes the repository is refused by name", async () => {
  const cases = [
    ["worktreeRoot", "/tmp/trees"],
    ["worktreeRoot", "../trees"],
    ["claimFile", "/tmp/claims.toml"],
    ["claimFile", "a/../../b.toml"],
  ];
  for (const [key, value] of cases) {
    assert.match(refusal({ [key]: value }), new RegExp(key), `${key} ${JSON.stringify(value)}`);
  }
});

await check("a bound that cannot work is refused by name", async () => {
  assert.match(refusal({ lockStaleSeconds: 0 }), /lockStaleSeconds/);
  assert.match(refusal({ lockStaleSeconds: 1.5 }), /lockStaleSeconds/);
  assert.match(refusal({ sweepAgeHours: 0 }), /sweepAgeHours/);
  assert.match(refusal({ sweepAgeHours: Number.NaN }), /sweepAgeHours/);
  assert.match(refusal({ branchSubjectMaxLength: 0 }), /branchSubjectMaxLength/);
});

await check("a guard value that is neither on nor off is refused by name", async () => {
  assert.match(refusal({ guard: "sometimes" }), /guard/);
});

report();
