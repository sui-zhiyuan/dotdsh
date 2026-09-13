/**
 * The committed check for the sign-in protocol: the device grant, the poll, the
 * Copilot token exchange, the model list, and every refusal in between — driven
 * end to end against a scripted transport, with no network.
 * Run: pnpm test
 *
 * This is the check that matters most for this package, because the protocol is
 * the part this package owns rather than borrows. A scripted `fetch` is what
 * makes that checkable: each call the flow makes is asserted (its URL, its body,
 * its headers) and each answer is chosen by this file, so the state machine —
 * poll, back off on `slow_down`, stop on the issuer's own terminal errors, keep
 * a usable grant when only the advisory model list fails — is pinned rather than
 * hoped for.
 *
 * The grant's shape is asserted field by field, including the five-minute
 * expiry margin, because the *result* is the contract with the adapter that
 * later refreshes it: the refresh token must be the GitHub token, the access
 * token the Copilot one, and the endpoint claimed by the token the official one.
 *
 * What a green run does NOT prove: that github.com or the Copilot endpoints
 * behave as scripted (no request leaves this process), that the public client id
 * is still accepted, or that a real grant authenticates a real model request —
 * that last one is a sign-in away, and `/copilot-status` is what reports it.
 */
import assert from "node:assert/strict";
import { COPILOT_CLIENT_ID, loginCopilot } from "../lib/login.js";
import { validateGrant } from "../lib/grant.js";

const COPILOT_TOKEN = "tid=abc;exp=1790000000;proxy-ep=proxy.individual.githubcopilot.com;iat=1700000000";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A transport that answers from a script and records every call. */
function scripted(answers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", body: init?.body, headers: init?.headers });
    const answer = answers.shift();
    if (answer === undefined) throw new Error(`unexpected request to ${String(url)}`);
    return answer;
  };
  return { fetchImpl, calls };
}

const DEVICE_OK = {
  device_code: "device-123",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  expires_in: 900,
};

/** Run a flow and return the notices it produced. */
async function run(answers, options = {}) {
  const { fetchImpl, calls } = scripted(answers);
  const notices = [];
  const controller = new AbortController();
  const grant = await loginCopilot({
    signal: options.signal ?? controller.signal,
    onNotice: (notice) => notices.push(notice),
    fetch: fetchImpl,
    pollIntervalSeconds: 0.001,
    ...(options.request ?? {}),
  });
  return { grant, notices, calls };
}

// ---------------------------------------------------------------- happy path
{
  const { grant, notices, calls } = await run([
    json(DEVICE_OK),
    json({ error: "authorization_pending" }),
    json({ error: "slow_down", interval: 0 }),
    json({ access_token: "ghu_github_token" }),
    json({ token: COPILOT_TOKEN, expires_at: 1_790_000_000 }),
    json({ data: [{ id: "gpt-5.4", policy: { state: "enabled" } }, { id: "claude-opus-5", policy: { state: "disabled" } }, { id: 7 }] }),
  ]);

  assert.equal(calls.length, 6);
  assert.equal(calls[0].url, "https://github.com/login/device/code");
  assert.equal(calls[0].method, "POST");
  assert.match(String(calls[0].body), new RegExp(`client_id=${COPILOT_CLIENT_ID}`));
  assert.match(String(calls[0].body), /scope=read%3Auser/);
  assert.equal(calls[1].url, "https://github.com/login/oauth/access_token");
  assert.match(String(calls[1].body), /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code/);
  assert.equal(calls[4].url, "https://api.github.com/copilot_internal/v2/token");
  assert.equal(calls[4].headers.Authorization, "Bearer ghu_github_token");
  assert.equal(calls[5].url, "https://api.individual.githubcopilot.com/models");
  assert.equal(calls[5].headers.Authorization, `Bearer ${COPILOT_TOKEN}`);

  const device = notices.find((notice) => notice.kind === "device-code");
  assert.deepEqual(device, {
    kind: "device-code",
    userCode: "ABCD-1234",
    verificationUri: "https://github.com/login/device",
    expiresInSeconds: 900,
  });
  assert.ok(notices.some((notice) => notice.kind === "progress" && notice.message.includes("Waiting for the authorization")));
  assert.ok(notices.some((notice) => notice.kind === "progress" && notice.message.includes("exchanging it for a Copilot token")));

  // The grant is exactly what the stock adapter reads, including the 5-minute margin.
  assert.deepEqual(grant, {
    type: "oauth",
    access: COPILOT_TOKEN,
    refresh: "ghu_github_token",
    expires: 1_790_000_000_000 - 300_000,
    availableModelIds: ["gpt-5.4"],
  });
  assert.equal(validateGrant(grant), true);
}

// ------------------------------------------------- the advisory list may fail
{
  const { grant, notices } = await run([
    json(DEVICE_OK),
    json({ access_token: "ghu_github_token" }),
    json({ token: COPILOT_TOKEN, expires_at: 1_790_000_000 }),
    json({ message: "nope" }, 500),
  ]);
  assert.equal(grant.availableModelIds, undefined, "a failed model list must not fail the sign-in");
  assert.ok(notices.some((notice) => notice.kind === "progress" && notice.message.includes("could not read the account model list")));
}

// --------------------------------------------------------- terminal refusals
const refusals = [
  [{ error: "access_denied" }, "DENIED"],
  [{ error: "expired_token" }, "EXPIRED"],
  [{ error: "unexpected_error" }, "DEVICE_CODE"],
];
for (const [errorBody, code] of refusals) {
  await assert.rejects(
    run([json(DEVICE_OK), json(errorBody)]),
    (error) => error.code === code,
    `expected ${code} for ${JSON.stringify(errorBody)}`,
  );
}

// A device response missing the fields a human needs is refused before anything is shown.
await assert.rejects(
  run([json({ device_code: "device-123" })]),
  (error) => error.code === "DEVICE_CODE",
);

// A token exchange that answered with a body, and a status, is redacted on the way out.
await assert.rejects(
  run([json(DEVICE_OK), json({ access_token: "ghu_x" }), new Response("upstream said no: token=super-secret", { status: 502 })]),
  (error) => {
    assert.equal(error.code, "TOKEN_EXCHANGE");
    assert.equal(error.message.includes("super-secret"), false);
    return true;
  },
);

// A token pointing at somebody else's endpoint is refused even though GitHub sent it.
await assert.rejects(
  run([
    json(DEVICE_OK),
    json({ access_token: "ghu_x" }),
    json({ token: "tid=1;proxy-ep=proxy.attacker.example", expires_at: 1_790_000_000 }),
  ]),
  (error) => error.code === "INVALID_GRANT",
);

// A token naming no endpoint at all cannot be called.
await assert.rejects(
  run([json(DEVICE_OK), json({ access_token: "ghu_x" }), json({ token: "tid=1", expires_at: 1_790_000_000 })]),
  (error) => error.code === "TOKEN_EXCHANGE",
);

// An exchange body without a usable expiry is refused rather than stored without one.
await assert.rejects(
  run([json(DEVICE_OK), json({ access_token: "ghu_x" }), json({ token: COPILOT_TOKEN })]),
  (error) => error.code === "TOKEN_EXCHANGE",
);

// -------------------------------------------------------------------- abort
{
  const controller = new AbortController();
  const { fetchImpl } = (() => {
    const calls = [];
    return {
      fetchImpl: async (url) => {
        calls.push(String(url));
        return String(url) === "https://github.com/login/device/code"
          ? json(DEVICE_OK)
          : new Promise(() => undefined);
      },
      calls,
    };
  })();
  const pending = loginCopilot({
    signal: controller.signal,
    onNotice: () => undefined,
    fetch: fetchImpl,
    pollIntervalSeconds: 0.02,
  });
  setTimeout(() => controller.abort(new Error("cancelled by the caller")), 10);
  await assert.rejects(pending, (error) => String(error.message).includes("cancelled by the caller"));
}

console.log("verify-login: ok");
