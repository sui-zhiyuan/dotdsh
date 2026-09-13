/**
 * The committed check for the grant boundary: which stored payloads this
 * package is willing to treat as a sign-in, how a payload is rendered for the
 * credential document, and that the record address still agrees with the
 * adapter that reads it.
 * Run: pnpm test
 *
 * The validation rules here are not style: two fields of a grant decide where
 * traffic goes, and both are outside this package's control once the record is
 * on disk. `access` carries the `proxy-ep` endpoint pi-ai turns into the
 * request base URL, and `enterpriseUrl` is what pi-ai builds the refresh
 * endpoint from while sending the refresh token. Every case below is one way a
 * payload could name a host this package never signed in to, including the
 * self-consistent forgery that a check trusting either field alone would pass.
 *
 * The record address is pinned as a literal: `llm-pi-ai/github-copilot` is the
 * address `@deepseek-ai/dsh-llm-pi-ai` reads at request time (it builds it with
 * `recordKeyFor("github-copilot")`). Importing that package here to compare
 * against it would pull its whole editor-plugin dependency tree into this
 * package's development install, so the contract is written down instead — and
 * `verify-cli.mjs` proves the other half of it by writing the record through
 * dsh's real credential provider and reading it back.
 *
 * What a green run does NOT prove: that GitHub marks a real token the way the
 * fixtures do (no network here), or that a live adapter actually reads this
 * address — `verify-cli.mjs` covers the store, and a real `/copilot-status`
 * after a real sign-in covers the route.
 */
import assert from "node:assert/strict";
import { COPILOT_RECORD_KEY, OFFICIAL_PROXY_HOST } from "../lib/constants.js";
import { jsonImage, proxyHostOf, validateGrant } from "../lib/grant.js";

/** A realistic Copilot access token: a semicolon-separated field list pi-ai parses. */
function accessToken(host = OFFICIAL_PROXY_HOST) {
  return `tid=abc123;exp=1790000000;proxy-ep=${host};iat=1700000000`;
}

function grant(overrides = {}) {
  return {
    type: "oauth",
    access: accessToken(),
    refresh: "ghu_example_refresh_token",
    expires: 1_790_000_000_000,
    availableModelIds: ["gpt-5.4", "claude-sonnet-5"],
    ...overrides,
  };
}

// The record this package writes is the record the adapter reads.
assert.equal(COPILOT_RECORD_KEY, "llm-pi-ai/github-copilot");

// A grant of the shape the flow produces is accepted.
assert.equal(validateGrant(grant()), true);

// Every way a payload could name another host is refused.
assert.equal(validateGrant(grant({ access: accessToken("proxy.attacker.example") })), false, "forged proxy-ep");
assert.equal(
  validateGrant(grant({ access: accessToken("proxy.attacker.example"), enterpriseUrl: "attacker.example" })),
  false,
  "self-consistent forgery: a host in both fields",
);
assert.equal(
  validateGrant(grant({ enterpriseUrl: "attacker.example" })),
  false,
  "official proxy-ep with a foreign refresh endpoint",
);
assert.equal(validateGrant(grant({ access: "tid=abc;exp=1;iat=2" })), false, "no proxy-ep at all");
assert.equal(validateGrant(grant({ access: accessToken("not a host") })), false, "proxy-ep that is not a host");

// An empty enterpriseUrl is what a hand-edited or re-serialized record produces;
// only a non-empty one is a redirection.
assert.equal(validateGrant(grant({ enterpriseUrl: "" })), true);
assert.equal(validateGrant(grant({ enterpriseUrl: undefined })), true);

// Shape failures that would otherwise surface mid-request, as an opaque auth error.
assert.equal(validateGrant(grant({ type: "api_key" })), false, "not an OAuth grant");
assert.equal(validateGrant(grant({ access: "" })), false, "empty access token");
assert.equal(validateGrant(grant({ refresh: "" })), false, "empty refresh token");
assert.equal(validateGrant(grant({ expires: "soon" })), false, "non-numeric expiry");
assert.equal(validateGrant(grant({ expires: Number.NaN })), false, "NaN expiry");
assert.equal(validateGrant(grant({ availableModelIds: "gpt-5.4" })), false, "model list that is not a list");
assert.equal(validateGrant(grant({ availableModelIds: ["gpt-5.4", 7] })), false, "model list with a non-string id");
assert.equal(validateGrant(null), false);
assert.equal(validateGrant([]), false);
assert.equal(validateGrant("grant"), false);

// proxyHostOf reads the field pi-ai reads, and answers undefined rather than throwing.
assert.equal(proxyHostOf(accessToken()), OFFICIAL_PROXY_HOST);
assert.equal(proxyHostOf("exp=1;proxy-ep=proxy.example.com;iat=2"), "proxy.example.com");
assert.equal(proxyHostOf("tid=abc"), undefined);
assert.equal(proxyHostOf("proxy-ep=;x=1"), undefined);

// jsonImage is the JSON round trip the credential seam requires: an absent
// member disappears, an absent array entry becomes null, and nothing else moves.
const image = jsonImage({ ...grant({ enterpriseUrl: undefined }), nested: { keep: 1, drop: undefined }, list: [1, undefined, 2] });
assert.deepEqual(image, {
  type: "oauth",
  access: accessToken(),
  refresh: "ghu_example_refresh_token",
  expires: 1_790_000_000_000,
  availableModelIds: ["gpt-5.4", "claude-sonnet-5"],
  nested: { keep: 1 },
  list: [1, null, 2],
});
assert.deepEqual(JSON.parse(JSON.stringify(image)), image, "the image survives JSON.stringify unchanged");
assert.equal(validateGrant(image), true, "the rendered image is still a usable grant");

console.log("verify-grant: ok");
