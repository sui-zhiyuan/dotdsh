/**
 * The committed check for this package's whole surface: the descriptor, the
 * config schema, and what `apply` registers on a stand-in Context.
 *
 * Why these assertions: the plugin contributes no tool and no page, so the only
 * thing that can go wrong silently is the *text* — a paragraph that no longer
 * says "an idle session is woken" leaves the model exactly where it was, and one
 * that drifts into restating the tool descriptions costs every turn. The checks
 * below pin the claims each paragraph exists for (wake on idle and its named
 * anti-patterns; headings carrying structure and the deletion test) rather than
 * the exact prose, so rewording is allowed and deleting a claim is not.
 *
 * Two things are pinned that the paragraphs alone would not show. Each section
 * has its own anchor and its own knob, so one can be emptied without the other;
 * and neither paragraph mentions the other's subject, so a later edit cannot
 * quietly merge two unrelated instructions back into one section.
 *
 * What a green run does NOT prove: that a real cordis fiber accepts the mount
 * (the Context here is a two-method stand-in), that a live `SystemPrompt`
 * registry admits either section or renders it into a prompt, or that the model
 * is shown the text as written. The boot check in doc/src/design.md covers the
 * row; the assembly is the harness's own.
 */
import assert from "node:assert/strict";

import {
	Config,
	DEFAULT_TEXT,
	DEFAULT_WRITING_TEXT,
	SECTION_NAME,
	WRITING_SECTION_NAME,
	apply,
	inject,
	name,
} from "../lib/index.js";

const check = (label, fn) => {
	try {
		fn();
		console.log(`ok   ${label}`);
	} catch (error) {
		console.error(`FAIL ${label}`);
		throw error;
	}
};

/** A stand-in registry: real order numbers per anchor, and a loud unknown. */
const ORDERS = { TOOL_SUBAGENT: 2800, TOOL_WRITE: 1200 };

const stubContext = () => {
	const orders = [];
	const sections = [];
	const ctx = {
		systemPrompt: {
			getSectionOrder(orderName) {
				orders.push(orderName);
				if (!(orderName in ORDERS)) throw new Error(`unexpected anchor "${orderName}"`);
				return ORDERS[orderName];
			},
			section(section) {
				sections.push(section);
				return () => {};
			},
		},
	};
	return { ctx, orders, sections };
};

check("declares the plugin name dsh derives from the package", () => {
	assert.equal(name, "agent-prompt");
});

check("requires the system-prompt registry", () => {
	assert.deepEqual(inject, ["systemPrompt"]);
});

check("the schema resolves one default per section", () => {
	const resolved = Config({});
	assert.equal(resolved.text, DEFAULT_TEXT);
	assert.equal(resolved.writingText, DEFAULT_WRITING_TEXT);
});

check("each knob is replaced independently, including with empty", () => {
	assert.equal(Config({ text: "custom waiting" }).text, "custom waiting");
	assert.equal(Config({ text: "custom waiting" }).writingText, DEFAULT_WRITING_TEXT);
	assert.equal(Config({ writingText: "custom writing" }).text, DEFAULT_TEXT);
	assert.equal(Config({ writingText: "" }).writingText, "");
	assert.equal(Config({ writingText: "" }).text, DEFAULT_TEXT);
});

check("a non-string knob is refused at the row boundary", () => {
	assert.throws(() => Config({ text: 42 }));
	assert.throws(() => Config({ writingText: 42 }));
});

check("apply registers one literal section per paragraph, each at its own slot", () => {
	const { ctx, orders, sections } = stubContext();
	apply(ctx, Config({}));

	assert.deepEqual(orders, ["TOOL_SUBAGENT", "TOOL_WRITE"]);
	assert.equal(sections.length, 2, "one section per paragraph");

	const byName = new Map(sections.map((section) => [section.name, section]));
	assert.deepEqual([...byName.keys()], [SECTION_NAME, WRITING_SECTION_NAME]);

	const waiting = byName.get(SECTION_NAME);
	assert.equal(waiting.order, ORDERS.TOOL_SUBAGENT);
	assert.equal(waiting.text, DEFAULT_TEXT);
	assert.equal(waiting.interpolate, false, "config prose must stay literal");

	const writing = byName.get(WRITING_SECTION_NAME);
	assert.equal(writing.order, ORDERS.TOOL_WRITE);
	assert.equal(writing.text, DEFAULT_WRITING_TEXT);
	assert.equal(writing.interpolate, false, "config prose must stay literal");
});

check("emptying one text leaves the other paragraph mounted", () => {
	const waitingOff = stubContext();
	apply(waitingOff.ctx, Config({ text: "" }));
	assert.equal(waitingOff.sections.length, 2, "an empty section is still handed through");
	assert.equal(waitingOff.sections[0].text, "");
	assert.equal(waitingOff.sections[1].text, DEFAULT_WRITING_TEXT);

	const writingOff = stubContext();
	apply(writingOff.ctx, Config({ writingText: "" }));
	assert.equal(writingOff.sections[0].text, DEFAULT_TEXT);
	assert.equal(writingOff.sections[1].text, "");
});

check("the waiting paragraph states the wake-on-idle fact", () => {
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

check("the writing paragraph puts the structure in the headings", () => {
	assert.match(DEFAULT_WRITING_TEXT, /headings carry its structure/i);
	assert.match(DEFAULT_WRITING_TEXT, /never announce it in prose/i);
});

check("it removes sentences by the deletion test, not by category", () => {
	assert.match(DEFAULT_WRITING_TEXT, /delete any sentence that describes how the text is organized/i);
	assert.match(DEFAULT_WRITING_TEXT, /removing it loses something the headings do not already give/i);
});

check("it removes the provenance of the document, not just its outline", () => {
	assert.match(DEFAULT_WRITING_TEXT, /leave no trace of the report or conversation/i);
});

check("neither paragraph has drifted into the other's subject", () => {
	assert.doesNotMatch(DEFAULT_TEXT, /headings|document|report\b|organized|outline/i);
	assert.doesNotMatch(DEFAULT_WRITING_TEXT, /subagent|`sleep`|`list_agents`|`interrupt_agent`/i);
});

check("each paragraph stays a paragraph, within its own budget", () => {
	for (const [label, text] of [
		["waiting", DEFAULT_TEXT],
		["writing", DEFAULT_WRITING_TEXT],
	]) {
		assert.equal(text.includes("\n"), false, `${label} text must not wrap`);
		assert.ok(text.length < 500, `${label} text is ${text.length} characters`);
	}
});
