/**
 * The committed check for the command surface: the three commands this plugin
 * registers, and the result text each one returns — mounted through a real
 * Cordis context, so `inject`, the effect lifecycle and the disposer are the
 * harness's own, while the credential store, the command registry and the
 * sign-in flow behind them are stand-ins this file controls.
 * Run: pnpm test
 *
 * Two layers are checked separately, and the split is deliberate. `apply` is
 * driven through `ctx.plugin` with the real plugin object, so what it wires —
 * which commands exist, and that a usage error is answered without starting
 * anything — is the shipped wiring. The sign-in branches are driven through
 * `registerCopilotCommands`, whose flow is injected: that is the only way to
 * reach the device-code path, the joining second call, the background write and
 * a redacted failure *without asking github.com for a real device code*, and it
 * is why the production `apply` wires the same function it exports.
 *
 * What a green run does NOT prove: that a real dsh session dispatches these
 * commands (the registry here is a Map, not `@deepseek-ai/dsh-commands`), that
 * the returned text is rendered as written, or that the live flow behaves as
 * the fake does (`verify-login.mjs` drives that protocol against a scripted
 * transport). Nothing model-facing is registered by this package at all, and a
 * future tool registration would have to appear here as a new assertion.
 */
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import * as CopilotAuth from "../lib/index.js";
import { COPILOT_RECORD_KEY, registerCopilotCommands, validateGrant } from "../lib/index.js";

const OFFICIAL_TOKEN = "tid=abc;exp=1790000000;proxy-ep=proxy.individual.githubcopilot.com;iat=1700000000";
const VALID_GRANT = {
  type: "oauth",
  access: OFFICIAL_TOKEN,
  refresh: "ghu_github_token",
  expires: 1_790_000_000_000,
  availableModelIds: ["gpt-5.4"],
};
const ROUTE_REGISTERED = { listProviders: () => [{ id: "github-copilot", name: "GitHub Copilot" }] };

/** The credential seam in memory: the same three calls, none of the file. */
function memoryCredentials(initial = {}) {
  const records = new Map(Object.entries(initial));
  return {
    records,
    readRecord: async (key) => records.get(key),
    modifyRecord: async (key, mutate) => {
      const next = await mutate(records.get(key));
      if (next === undefined) records.delete(key);
      else records.set(key, next);
      return next;
    },
    deleteRecord: async (key) => {
      records.delete(key);
    },
  };
}

/** A command registry that keeps the definitions reachable for this file. */
function commandRegistry() {
  const definitions = new Map();
  return {
    definitions,
    register(definition) {
      definitions.set(definition.name, definition);
      return () => definitions.delete(definition.name);
    },
  };
}

/** Mount the real plugin object, exactly as the loader's row does. */
async function mount({ credentials, commands, llm }) {
  const ctx = new Context();
  ctx.provide("credentials", credentials);
  ctx.provide("commands", commands);
  if (llm !== undefined) ctx.provide("llm", llm);
  return await ctx.plugin(CopilotAuth, {});
}

/** Register the same commands directly, with a flow this file controls. */
function register({ credentials, login, routeConfigured }) {
  const commands = commandRegistry();
  const logins = [];
  const dispose = registerCopilotCommands(commands, {
    credentials,
    login: async (request) => {
      logins.push(request);
      return await login(request);
    },
    loginWindowMs: 60_000,
    ...(routeConfigured === undefined ? {} : { routeConfigured }),
  });
  return { commands, dispose, logins };
}

/** The one field the handlers read; the rest of the invocation is the harness's. */
const invoke = (rawInput = "") => ({
  commandId: "command-1",
  agent: {},
  rawInput,
  attachments: [],
  signal: new AbortController().signal,
});

/** Run one command by name through the registered definition. */
async function run(commands, name, rawInput = "") {
  const definition = commands.definitions.get(name);
  assert.ok(definition !== undefined, `command /${name} is registered`);
  return await definition.handler(invoke(rawInput));
}

/** Wait for the background continuation to land, without racing it. */
async function settledCredential(credentials, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (credentials.records.has(COPILOT_RECORD_KEY)) return credentials.records.get(COPILOT_RECORD_KEY);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return credentials.records.get(COPILOT_RECORD_KEY);
}

/** A flow that shows a device code and then finishes, on demand. */
function deviceCodeFlow({ grant = VALID_GRANT, settleAfterMs = 10, fail = undefined } = {}) {
  return async ({ onNotice }) => {
    onNotice({
      kind: "device-code",
      userCode: "WXYZ-9999",
      verificationUri: "https://github.com/login/device",
      expiresInSeconds: 900,
    });
    await new Promise((resolve) => setTimeout(resolve, settleAfterMs));
    if (fail !== undefined) throw fail;
    return grant;
  };
}

// ------------------------------------------------------- what `apply` wires
{
  const credentials = memoryCredentials();
  const commands = commandRegistry();
  const fiber = await mount({ credentials, commands, llm: { listProviders: () => [] } });
  assert.deepEqual([...commands.definitions.keys()], ["copilot-login", "copilot-status", "copilot-logout"]);
  for (const definition of commands.definitions.values()) assert.ok(definition.description.length > 0);

  // Status while signed out tells the human BOTH facts they need: no sign-in,
  // and nothing serving the route until settings declare it.
  const signedOut = await run(commands, "copilot-status");
  assert.equal(signedOut.kind, "success");
  assert.match(signedOut.text, /not signed in/);
  assert.ok(signedOut.text.includes("llm-pi-ai:"), "the settings snippet is shown when no route is registered");

  // An argument is answered before any flow starts — the shipped wiring reaches
  // the real flow here, so this is also what proves the path is argument-gated.
  const args = await run(commands, "copilot-login", "please");
  assert.equal(args.kind, "error");
  assert.match(args.text, /Usage/);

  await fiber.dispose();
  assert.equal(commands.definitions.size, 0, "unloading the plugin unregisters its commands");
}

// --------------------------------------------------- status and logout branches
{
  const credentials = memoryCredentials();
  const commands = commandRegistry();
  const fiber = await mount({ credentials, commands, llm: ROUTE_REGISTERED });

  const signedOut = await run(commands, "copilot-status");
  assert.match(signedOut.text, /not signed in/);
  assert.equal(signedOut.text.includes("llm-pi-ai:"), false, "a registered route is reported, not hinted at");

  // A record that fails validation is reported as unusable, not as a sign-in.
  credentials.records.set(COPILOT_RECORD_KEY, {
    kind: "grant",
    payload: { ...VALID_GRANT, access: "tid=1;proxy-ep=proxy.attacker.example" },
  });
  const forged = await run(commands, "copilot-status");
  assert.equal(forged.kind, "error");
  assert.match(forged.text, /did not pass validation/);

  // ...and logout still clears it, which is the recovery that message asks for.
  const cleared = await run(commands, "copilot-logout");
  assert.equal(cleared.kind, "success");
  assert.match(cleared.text, /was removed/);
  assert.equal(credentials.records.size, 0);
  assert.match((await run(commands, "copilot-logout")).text, /No GitHub Copilot grant was stored/);

  await fiber.dispose();
}

// ------------------------------------------------------------- login branches
{
  const credentials = memoryCredentials();
  const { commands, dispose, logins } = register({
    credentials,
    login: deviceCodeFlow({ settleAfterMs: 10 }),
    routeConfigured: () => true,
  });

  const started = await run(commands, "copilot-login");
  assert.equal(started.kind, "success");
  assert.ok(started.text.includes("https://github.com/login/device"));
  assert.ok(started.text.includes("WXYZ-9999"));
  assert.ok(started.text.includes("valid for about 15 minutes"));
  assert.equal(logins.length, 1);

  // The flow keeps running after the answer: the grant must land in the store.
  const record = await settledCredential(credentials);
  assert.ok(record !== undefined, "the finished flow stored its grant");
  assert.equal(record.kind, "grant");
  assert.equal(validateGrant(record.payload), true);

  const signedIn = await run(commands, "copilot-status");
  assert.match(signedIn.text, /is signed in/);
  assert.ok(signedIn.text.includes("gpt-5.4"), "the account model list is reported");

  // A second sign-in is refused rather than replacing a working grant.
  const second = await run(commands, "copilot-login");
  assert.equal(second.kind, "error");
  assert.match(second.text, /already signed in/);
  assert.equal(logins.length, 1);

  dispose();
  assert.equal(commands.definitions.size, 0);
}

// --------------------------------------------- a second call joins the first
{
  const credentials = memoryCredentials();
  const { commands, dispose, logins } = register({ credentials, login: deviceCodeFlow({ settleAfterMs: 3_000 }) });
  const joining = run(commands, "copilot-login");
  const second = await run(commands, "copilot-login");
  assert.equal(second.kind, "success");
  assert.match(second.text, /already in progress/);
  assert.equal(logins.length, 1, "the second call never started a second attempt");
  dispose();
  await joining.catch(() => undefined);
}

// ------------------------------------------------------ failures are redacted
{
  // A flow that fails before it can show anything is reported to the human, and
  // the provider's own text is redacted on the way.
  const credentials = memoryCredentials();
  const { commands, dispose } = register({
    credentials,
    login: async () => {
      throw new Error("device flow failed: token=super-secret");
    },
  });
  const failed = await run(commands, "copilot-login");
  assert.equal(failed.kind, "error");
  assert.match(failed.text, /sign-in failed/);
  assert.equal(failed.text.includes("super-secret"), false, "the provider text is redacted before it is returned");
  assert.match((await run(commands, "copilot-status")).text, /not signed in/);
  dispose();
}

// ------------------------------- a flow that dies after showing its code
{
  const credentials = memoryCredentials();
  const warnings = [];
  const commands = commandRegistry();
  const dispose = registerCopilotCommands(commands, {
    credentials,
    login: deviceCodeFlow({ fail: new Error("the authorization never arrived") }),
    loginWindowMs: 60_000,
    warn: (message, error) => warnings.push({ message, error }),
  });
  const shown = await run(commands, "copilot-login");
  assert.equal(shown.kind, "success", "the device code is the answer, even if the flow later fails");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(credentials.records.size, 0, "a failed attempt stored nothing");
  assert.equal(warnings.length, 1, "the background failure reaches the host log");
  assert.match(warnings[0].message, /did not finish/);
  assert.match((await run(commands, "copilot-status")).text, /not signed in/);
  dispose();
}

console.log("verify-commands: ok");
