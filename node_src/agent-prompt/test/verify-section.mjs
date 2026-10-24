/**
 * The committed check for this package's whole surface: the descriptor, the
 * config schema, and what `apply` registers on a stand-in Context.
 *
 * Why these assertions: the plugin contributes no tool and no page, so the only
 * thing that can go wrong silently is the *text* — a paragraph that no longer
 * says "an idle session is woken" leaves the model exactly where it was, and one
 * that drifts into restating the tool descriptions costs every turn. The checks
 * below pin the three claims the paragraph exists for (wake on idle, the named
 * anti-patterns, the bounded-watchdog alternative) rather than the exact prose,
 * so rewording is allowed and deleting a claim is not.
 *
 * What a green run does NOT prove: that a real cordis fiber accepts the mount
 * (the Context here is a two-method stand-in), that a live `SystemPrompt`
 * registry admits the section or renders it into a prompt, or that the model is
 * shown the text as written. The boot check in doc/src/design.md covers the row;
 * the assembly is the harness's own.
 */
import assert from "node:assert/strict";

import { Config, DEFAULT_TEXT, SECTION_NAME, apply, inject, name } from "../lib/index.js";

const check = (label, fn) => {
	try {
		fn();
		console.log(`ok   ${label}`);
	} catch (error) {
		console.error(`FAIL ${label}`);
		throw error;
	}
};

check("declares the plugin name dsh derives from the package", () => {
	assert.equal(name, "agent-prompt");
});

check("requires the system-prompt registry", () => {
	assert.deepEqual(inject, ["systemPrompt"]);
});

check("the schema resolves its default text", () => {
	const resolved = Config({});
	assert.equal(resolved.text, DEFAULT_TEXT);
});

check("the row config replaces the text, including with empty", () => {
	assert.equal(Config({ text: "custom paragraph" }).text, "custom paragraph");
	assert.equal(Config({ text: "" }).text, "");
});

check("a non-string text is refused at the row boundary", () => {
	assert.throws(() => Config({ text: 42 }));
});

check("apply registers one section at the subagent slot, literal", () => {
	const orders = [];
	const sections = [];
	const ctx = {
		systemPrompt: {
			getSectionOrder(orderName) {
				orders.push(orderName);
				return 2800;
			},
			section(section) {
				sections.push(section);
				return () => {};
			},
		},
	};
	apply(ctx, Config({}));

	assert.deepEqual(orders, ["TOOL_SUBAGENT"]);
	assert.equal(sections.length, 1, "one section per mount");
	const [section] = sections;
	assert.equal(section.name, SECTION_NAME);
	assert.equal(section.order, 2800);
	assert.equal(section.text, DEFAULT_TEXT);
	assert.equal(section.interpolate, false, "config prose must stay literal");
});

check("an empty text is handed through unchanged (the disable path)", () => {
	const sections = [];
	apply(
		{ systemPrompt: { getSectionOrder: () => 2800, section: (section) => sections.push(section) } },
		Config({ text: "" }),
	);
	assert.equal(sections[0].text, "");
});

check("the default text states the wake-on-idle fact", () => {
	assert.match(DEFAULT_TEXT, /idle/i);
	assert.match(DEFAULT_TEXT, /wakes you with a new turn/i);
	assert.match(DEFAULT_TEXT, /ending your turn is a valid way to wait/i);
});

check("it names the anti-patterns it replaces", () => {
	for (const pattern of [/`sleep`/, /background timers/i, /`list_agents`/]) {
		assert.match(DEFAULT_TEXT, pattern);
	}
});

check("it keeps the one legitimate use: a bounded watchdog", () => {
	assert.match(DEFAULT_TEXT, /one bounded timer/i);
	assert.match(DEFAULT_TEXT, /`interrupt_agent`/);
});

check("the paragraph stays a paragraph", () => {
	assert.equal(DEFAULT_TEXT.includes("\n"), false);
	assert.ok(DEFAULT_TEXT.length < 500, `text is ${DEFAULT_TEXT.length} characters`);
});
