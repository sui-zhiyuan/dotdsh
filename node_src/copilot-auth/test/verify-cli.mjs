/**
 * The committed check for the CLI boundary: the argument grammar, the exit
 * codes, and the round trip that matters — a grant seeded through dsh's own
 * credential provider is reported by `status`, refused by validation when it is
 * forged, and removed by `logout`.
 * Run: pnpm test
 *
 * The CLI is spawned as a child process, so what is exercised is the real entry
 * point: the shebang, the `bin` target, its own Cordis context with the real
 * `@deepseek-ai/dsh-credentials-local`, and the file it writes. Seeding is done
 * in this process through that same provider rather than by writing YAML, so the
 * check proves the two halves agree about the document — a format this CLI never
 * parses itself.
 *
 * Every run uses a fresh `mktemp -d` home, and `--dsh-home` is exercised against
 * a second one, so nothing here can read or write a real `~/.dsh`.
 *
 * What a green run does NOT prove: that a real sign-in completes (no network
 * here — `verify-login.mjs` drives that state machine against a scripted
 * transport), that a running dsh picks the record up mid-flight (the store's
 * cross-process lock is dsh's own code path, exercised by the provider, not by
 * this check), or that the Copilot route then serves a request.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import CredentialsLocal from "@deepseek-ai/dsh-credentials-local";
import { COPILOT_RECORD_KEY } from "../lib/constants.js";
import { validateGrant } from "../lib/grant.js";

const CLI = fileURLToPath(new URL("../lib/cli.js", import.meta.url));
const OFFICIAL_TOKEN = "tid=abc;exp=1790000000;proxy-ep=proxy.individual.githubcopilot.com;iat=1700000000";
const VALID_GRANT = { type: "oauth", access: OFFICIAL_TOKEN, refresh: "ghu_github_token", expires: 1_790_000_000_000 };

const homes = [];
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "dotdsh-copilot-auth-"));
  homes.push(home);
  return home;
}

/** Run the CLI with a home in the environment, exactly as a user would. */
function run(args, home) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: { ...process.env, DSH_HOME: home },
    timeout: 30_000,
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

/** Seed a record through the real provider — the same service the CLI mounts. */
async function seed(home, payload) {
  const ctx = new Context();
  await ctx.plugin(CredentialsLocal, { dshHome: home, watch: false });
  await ctx.credentials.modifyRecord(COPILOT_RECORD_KEY, () => Promise.resolve({ kind: "grant", payload }));
  await ctx.fiber.dispose();
}

/** Read back what the document holds, through the real provider again. */
async function stored(home) {
  const ctx = new Context();
  await ctx.plugin(CredentialsLocal, { dshHome: home, watch: false });
  const record = await ctx.credentials.readRecord(COPILOT_RECORD_KEY);
  await ctx.fiber.dispose();
  return record;
}

try {
  // -------------------------------------------------------------- usage errors
  const usage = run([], makeHome());
  assert.equal(usage.code, 2);
  assert.match(usage.err, /Usage:/);

  const badCommand = run(["bogus"], makeHome());
  assert.equal(badCommand.code, 2, "an unknown command is a usage error, not a silent no-op");
  assert.match(badCommand.err, /unknown command bogus/);

  const badTimeout = run(["login", "--timeout", "abc"], makeHome());
  assert.equal(badTimeout.code, 2);
  assert.match(badTimeout.err, /--timeout must be a positive integer/);

  const unknownOption = run(["status", "--dshhome", "/tmp/x"], makeHome());
  assert.equal(unknownOption.code, 2, "a mistyped option must not silently fall back to the default home");
  assert.match(unknownOption.err, /unknown option --dshhome/);

  // ------------------------------------------------------------- signed out
  const emptyHome = makeHome();
  const signedOut = run(["status"], emptyHome);
  assert.equal(signedOut.code, 1, "status exits non-zero when nothing usable is stored");
  assert.match(signedOut.out, /Not signed in to GitHub Copilot/);

  const nothingToRemove = run(["logout"], makeHome());
  assert.equal(nothingToRemove.code, 0);
  assert.match(nothingToRemove.out, /No GitHub Copilot grant was stored/);

  // -------------------------------------------------------------- signed in
  const home = makeHome();
  await seed(home, VALID_GRANT);
  const document = join(home, ".credentials.yaml");
  assert.ok(existsSync(document), "the provider created the credential document");
  assert.equal(statSync(document).mode & 0o777, 0o600, "the document is owner-only");

  const signedIn = run(["status"], home);
  assert.equal(signedIn.code, 0);
  assert.match(signedIn.out, /Signed in to GitHub Copilot/);
  assert.ok(signedIn.out.includes(new Date(VALID_GRANT.expires).toISOString()), `the expiry is reported: ${signedIn.out}`);

  // The flag, not just the environment, decides which home is read.
  const otherHome = makeHome();
  const elsewhere = run(["status", "--dsh-home", otherHome], home);
  assert.equal(elsewhere.code, 1, "--dsh-home overrides DSH_HOME");

  // -------------------------------------------------------- a forged record
  const forgedHome = makeHome();
  await seed(forgedHome, { ...VALID_GRANT, access: "tid=1;proxy-ep=proxy.attacker.example" });
  const forged = run(["status"], forgedHome);
  assert.equal(forged.code, 1);
  assert.match(forged.err, /did not pass validation/);
  // And it is never handed on: the CLI reports the same refusal the plugin would.
  assert.equal(validateGrant({ ...VALID_GRANT, access: "tid=1;proxy-ep=proxy.attacker.example" }), false);

  // ---------------------------------------------------------------- logout
  const removed = run(["logout"], home);
  assert.equal(removed.code, 0);
  assert.match(removed.out, /Signed out/);
  assert.equal(await stored(home), undefined, "the record is gone from the document");
  assert.equal(run(["status"], home).code, 1);

  // The document survives the round trip: nothing else in it was rewritten away.
  assert.ok(readFileSync(document, "utf8").includes("version: 1"));

  console.log("verify-cli: ok");
} finally {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
}
