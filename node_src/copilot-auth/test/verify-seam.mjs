/**
 * The committed check for the authorization-seam half: the module that starts
 * dsh's own GitHub Copilot flow and carries the conversation with the human.
 * Run: pnpm test
 *
 * The seam is driven with a fake `ctx.authorization`, so what is pinned is this
 * package's half of the contract: the request it builds (the record key, the
 * `oauth` method, the caller's signal, an interaction it supplies), how it
 * restates pi-ai's notices in this package's vocabulary, the one prompt it
 * answers — GitHub Enterprise, blank for github.com — and the decline it uses
 * for anything else. Each of those is what makes the attempt settle the way the
 * caller expects.
 *
 * What this file deliberately does NOT need is a protocol: no device code is
 * requested, no token is exchanged, and no record is written. That is the point
 * of the change this module exists for — pi-ai runs the protocol and commits
 * the record, and the checks below assert only that the seam conditions
 * (`NO_FLOW`, `ALREADY_IN_FLIGHT`, `UNKNOWN_METHOD`, a cancelled attempt, a
 * protocol failure) reach the caller with the right shape and text.
 *
 * What a green run does NOT prove: that `dsh-llm-pi-ai` registers the flow, that
 * a real surface renders the notices, or that a real flow maps
 * `AuthorizationDeclinedError` to `cancelled` the way the fake here does. That
 * last mapping is the seam's own code (`attempt()` in `dsh-authorization`), not
 * this package's.
 */
import assert from "node:assert/strict";
import { AuthorizationDeclinedError, AuthorizationError } from "@deepseek-ai/dsh-authorization";
import { COPILOT_RECORD_KEY } from "../lib/constants.js";
import {
  beginCopilotSignIn,
  CopilotSignInError,
  ENTERPRISE_UNSUPPORTED_TEXT,
  NO_FLOW_TEXT,
} from "../lib/seam.js";

const ENTERPRISE_MESSAGE = "GitHub Enterprise URL/domain (blank for github.com)";

/** A `ctx.authorization` whose `begin` runs one scripted attempt and records the request. */
function fakeSeam(script) {
  const seen = [];
  return {
    seen,
    async begin(request) {
      seen.push(request);
      return await script(request);
    },
  };
}

const authorized = () => ({ status: "authorized" });
const cancelled = () => ({ status: "cancelled" });

/** A notice sink that keeps everything the seam reports. */
function noticeSink() {
  const notices = [];
  return { notices, onNotice: (notice) => notices.push(notice) };
}

const signal = () => new AbortController().signal;

// ---------------------------------------------------- the request begin() builds
{
  const seam = fakeSeam(async (request) => {
    assert.equal(request.key, COPILOT_RECORD_KEY, "the record key is the one the stock route reads");
    assert.equal(request.method, "oauth", "the method is the one pi-ai's copilot login declares");
    assert.equal(typeof request.interaction.notify, "function");
    assert.equal(typeof request.interaction.prompt, "function");
    return authorized();
  });
  const requestSignal = signal();
  const { notices, onNotice } = noticeSink();
  await beginCopilotSignIn(seam, { signal: requestSignal, onNotice });
  assert.equal(seam.seen.length, 1);
  assert.equal(seam.seen[0].signal, requestSignal, "the caller's signal withdraws the attempt");
  assert.deepEqual(notices, []);
}

// ------------------------------------------------------- notices -> this package
{
  const seam = fakeSeam(async (request) => {
    // pi-ai's device_code relay, verbatim: the URL and the code, no expiry.
    request.interaction.notify({
      message: "Enter this code on the verification page to finish signing in.",
      url: "https://github.com/login/device",
      code: "ABCD-1234",
    });
    request.interaction.notify({ message: "Signing in…" });
    return authorized();
  });
  const { notices, onNotice } = noticeSink();
  await beginCopilotSignIn(seam, { signal: signal(), onNotice });
  assert.deepEqual(
    notices,
    [
      { kind: "device-code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device" },
      { kind: "progress", message: "Signing in…" },
    ],
    "a code+URL pair is the device-code notice; everything else is progress",
  );
}

// ---------------------------------------------- the one prompt this package answers
{
  const seam = fakeSeam(async (request) => {
    const answer = await request.interaction.prompt({
      kind: "text",
      message: ENTERPRISE_MESSAGE,
      placeholder: "company.ghe.com",
    });
    assert.equal(answer, "", "blank means github.com");
    return authorized();
  });
  const { notices, onNotice } = noticeSink();
  await beginCopilotSignIn(seam, { signal: signal(), onNotice });
  assert.deepEqual(
    notices,
    [{ kind: "info", message: ENTERPRISE_UNSUPPORTED_TEXT }],
    "the human is told why the enterprise question was not asked",
  );
}

// ------------------------------------------- every other prompt is declined, not guessed
for (const prompt of [
  { kind: "select", message: "Which account?", options: [{ id: "a", label: "A" }] },
  { kind: "secret", message: "Paste a token" },
  { kind: "text", message: "Some other question" },
]) {
  let declined;
  const seam = fakeSeam(async (request) => {
    try {
      await request.interaction.prompt(prompt);
    } catch (error) {
      declined = error;
      return cancelled();
    }
    throw new Error("the unexpected prompt must not be answered");
  });
  const { notices, onNotice } = noticeSink();
  await assert.rejects(
    beginCopilotSignIn(seam, { signal: signal(), onNotice }),
    (error) => error instanceof CopilotSignInError && error.code === "CANCELLED",
    `a ${prompt.kind} prompt settles as cancelled`,
  );
  assert.ok(
    declined instanceof AuthorizationDeclinedError,
    "the decline is the seam's own signal, so the attempt is refused rather than failed",
  );
  assert.deepEqual(notices, []);
}

// ------------------------------------------------------ NO_FLOW, from both causes
{
  await assert.rejects(
    beginCopilotSignIn(undefined, { signal: signal(), onNotice: () => undefined }),
    (error) => error instanceof CopilotSignInError && error.code === "NO_FLOW" && error.message === NO_FLOW_TEXT,
    "an absent authorization service is reported as NO_FLOW",
  );
  await assert.rejects(
    beginCopilotSignIn({}, { signal: signal(), onNotice: () => undefined }),
    (error) => error instanceof CopilotSignInError && error.code === "NO_FLOW",
    "a service without begin() is reported as NO_FLOW",
  );
  const seam = fakeSeam(() => {
    throw new AuthorizationError("no authorization flow is registered", "NO_FLOW");
  });
  await assert.rejects(
    beginCopilotSignIn(seam, { signal: signal(), onNotice: () => undefined }),
    (error) => error instanceof CopilotSignInError && error.code === "NO_FLOW" && error.message === NO_FLOW_TEXT,
    "the seam's own NO_FLOW becomes the actionable message",
  );
}

// ------------------------------------------- the other named seam failures are mapped
for (const [code, expected] of [
  ["ALREADY_IN_FLIGHT", "ALREADY_IN_FLIGHT"],
  ["UNKNOWN_METHOD", "UNKNOWN_METHOD"],
]) {
  const seam = fakeSeam(() => {
    throw new AuthorizationError(`seam refused: ${code}`, code);
  });
  await assert.rejects(
    beginCopilotSignIn(seam, { signal: signal(), onNotice: () => undefined }),
    (error) => error instanceof CopilotSignInError && error.code === expected,
    `${code} is mapped`,
  );
}

// --------------------------------------- a cancelled outcome is not a written record
{
  const seam = fakeSeam(() => cancelled());
  await assert.rejects(
    beginCopilotSignIn(seam, { signal: signal(), onNotice: () => undefined }),
    (error) => error instanceof CopilotSignInError && error.code === "CANCELLED",
    "a cancelled attempt carries no record, so it is reported as cancelled",
  );
}

// ------------------------------- an unnamed failure survives with its own message
for (const original of [new Error("the protocol broke"), new AuthorizationError("no commit observed", "NOT_COMMITTED")]) {
  const seam = fakeSeam(() => {
    throw original;
  });
  await assert.rejects(
    beginCopilotSignIn(seam, { signal: signal(), onNotice: () => undefined }),
    (error) => error === original,
    "a failure this package cannot name is not swallowed or rewritten",
  );
}

console.log("verify-seam: ok");
