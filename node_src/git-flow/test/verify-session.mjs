// The committed check for the identity every decision is keyed by.
//
// This looks like a two-line utility, and it decides more than any other function
// here: whether a session is a competitor or family, which branch it may write on,
// whether it gets a checkout of its own. The failure it prevents is the one that
// motivated it — keyed by the immediate session id, whichever of a subagent and its
// parent wrote first owned the ledger record, and the other then saw a stranger and
// opened a *second* branch in the same working directory, moving it out from under
// the first.
//
// What a green run does NOT mean: nothing here is a live dsh session. The registry
// is a map, so what is proven is the walk over the chain it reports, not that the
// harness keeps a delegating ancestor resident — and when it does not, the walk
// stops early by design (see the third case).
import assert from "node:assert/strict";
import { isDelegate, sessionRoot } from "../lib/session.js";

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

/** An agent with the given id and header, and no conversation. */
function agent(id, header = {}) {
  return { session: { id, header, deriveMessages: () => [] } };
}

/** A registry answering with the given headers, so a chain can be walked. */
function registry(headers) {
  return { get: (id) => (id in headers ? { header: headers[id] } : undefined) };
}

console.log("session identity");

await verify("a top-level session is its own root", () => {
  assert.equal(sessionRoot(agent("s1", { cwd: "/repo" }), registry({})), "s1");
  assert.equal(isDelegate(agent("s1", {})), false);
});

await verify("walks to the topmost ancestor, however deep the chain", () => {
  // Keyed one hop up instead, a grandchild would disagree with its grandparent about
  // which record is theirs — which is the second-branch bug one generation later.
  const sessions = registry({
    s2: { parentSession: "s1" },
    s1: {},
  });
  assert.equal(sessionRoot(agent("s3", { parentSession: "s2" }), sessions), "s1");
});

await verify("stops only where the chain stops being readable", () => {
  // A reachable intermediate still reveals the ancestor above it, so the root is
  // named even when that ancestor is no longer resident — which is the *more*
  // consistent answer, because that ancestor computes the same root for itself.
  const partial = registry({ s2: { parentSession: "s1" } });
  assert.equal(sessionRoot(agent("s3", { parentSession: "s2" }), partial), "s1");

  // When the parent itself cannot be looked up there is nothing further to walk, and
  // the parent's id is the identity: coarser than the truth, never a split.
  assert.equal(sessionRoot(agent("s3", { parentSession: "s2" }), registry({})), "s2");
  assert.equal(sessionRoot(agent("s9", { parentSession: "gone" }), registry({})), "gone");
});

await verify("survives a cycle rather than looping forever", () => {
  const sessions = registry({ a: { parentSession: "b" }, b: { parentSession: "a" } });
  assert.equal(typeof sessionRoot(agent("a", { parentSession: "b" }), sessions), "string");
});

await verify("recognises a delegate by either marker the harness sets", () => {
  assert.equal(isDelegate(agent("s1", { origin: "subagent" })), true);
  assert.equal(isDelegate(agent("s1", { delegationDepth: 1 })), true);
  assert.equal(isDelegate(agent("s1", { delegationDepth: 0 })), false);
  assert.equal(isDelegate(agent("s1", {})), false);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
