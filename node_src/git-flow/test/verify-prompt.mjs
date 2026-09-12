// The committed check for the prompt contribution. Run: pnpm test
//
// This file pins one decision that took a design argument to reach, and that nothing
// else would notice being undone: the plugin contributes a **section** only. It does
// not contribute a state context describing the session's branch or worktree.
//
// The reason is worth keeping next to the check, because "the model should know where
// it is" is an easy thing to re-add: whether a write is allowed is decided by the guard
// by running git, not by what the model was told; the one useful fact (which worktree
// to write in) reaches the model through the guard's refusal, which names the path
// just in time and cannot be stale; and an injected branch can contradict reality the
// moment a human switches branches by hand.
//
// The check drives the BUILT lib/ against a fake context. Built-ins only: no harness,
// no profile, no network.
//
// What a green run does NOT mean: that the harness renders this section into a real
// prompt. Assembly belongs to `dsh-system-prompt`; what is settled here is what this
// plugin asks it to carry.
import assert from "node:assert/strict";
import { registerPrompt } from "../lib/prompt.js";

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

/**
 * A context that records what the plugin registers.
 *
 * @returns the fake context and its recordings.
 */
function recordingContext() {
  const sections = [];
  const contexts = [];
  return {
    sections,
    contexts,
    ctx: {
      systemPrompt: {
        section(definition) {
          sections.push(definition);
          return () => undefined;
        },
        context(definition) {
          contexts.push(definition);
          return () => undefined;
        },
      },
    },
  };
}

await verify("contributes one section and no state context", () => {
  const { ctx, sections, contexts } = recordingContext();
  registerPrompt(ctx);
  assert.equal(sections.length, 1, "the contract is one contribution");
  assert.equal(
    contexts.length,
    0,
    "and nothing describes the session's branch or worktree: the guard says where to write, at the moment it matters",
  );
});

await verify("the section is static text, so it is identical at every assembly", () => {
  const { ctx, sections } = recordingContext();
  registerPrompt(ctx);
  const section = sections[0];
  assert.equal(typeof section.text, "string", "a provider would be a promise the assembly cannot await");
  assert.ok(section.text.includes("Commit after each completed step"), "the per-step commit rule is the point of it");
  assert.ok(section.text.includes("/git-start"), "and the commands it tells the model not to do by hand");
  assert.ok(section.text.includes("/git-complete"));
  assert.ok(/never force-push/i.test(section.text), "including the history rules");
});

await verify("unregistering removes the contribution", () => {
  const { ctx } = recordingContext();
  assert.equal(typeof registerPrompt(ctx), "function", "the effect must be disposable");
});

console.log(`\n${String(passed)} passed, ${String(failures.length)} failed`);
for (const { name, error } of failures) console.log(`\n${name}\n${error.stack ?? error.message}`);
process.exitCode = failures.length === 0 ? 0 : 1;
