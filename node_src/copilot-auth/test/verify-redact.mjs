/**
 * The committed check for what may be shown: the redaction every user-visible
 * failure goes through.
 * Run: pnpm test
 *
 * The strings here are the shapes a real failure carries — a JWT in a decoder
 * message, a form-encoded device-flow error, a JSON body quoting the request
 * back. The point is narrow and worth stating: this is a display filter, and
 * the check proves exactly that. It does not prove that no secret can reach a
 * surface (an unrecognized format would pass through), and nothing in this
 * package makes a security decision from its output — the one such decision is
 * `validateGrant` over the stored payload.
 */
import assert from "node:assert/strict";
import { safeMessage } from "../lib/redact.js";

const JWT =
  "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk";
assert.equal(safeMessage(new Error(`token decode failed for ${JWT}`)).includes(JWT), false, "a JWT is not echoed");
assert.equal(safeMessage(new Error(`{"error":"bad_verification_code","device_code":"abc123"}`)).includes("abc123"), false);
assert.equal(safeMessage(new Error("access_token=ghu_secret&scope=read:user")).includes("ghu_secret"), false);
assert.equal(safeMessage(new Error('"refresh_token": "ghr_secret"')).includes("ghr_secret"), false);
assert.equal(safeMessage("plain failure").includes("plain failure"), true, "ordinary text survives");

// The bound keeps a hostile body from flooding a transcript or a terminal.
assert.equal(safeMessage(new Error("x".repeat(5_000))).length, 1_000);
assert.equal(safeMessage({ toString: () => "not an Error" }), "not an Error");

console.log("verify-redact: ok");
