import type { Context } from "@deepseek-ai/cordis";
import type { PromptSection, PromptSectionOrderName } from "@deepseek-ai/dsh-system-prompt";
import z from "@deepseek-ai/schemastery";

/**
 * The paragraphs this package adds to every agent's system prompt, one section
 * each.
 *
 * They stay apart on purpose. They answer unrelated questions — how to wait for
 * a delegated subagent, and how to write a document a human will read — they are
 * worth different numbers of tokens, and a deployment may well want the second
 * without the first. Welding them into one paragraph makes each of those
 * decisions impossible at once, which is why this package's own budget check
 * failed the single time it was tried: a section that carries two concerns has
 * no length it can honestly be held to.
 */

/**
 * The waiting paragraph.
 *
 * The shipped tool descriptions promise a completion notice (`subagent`) and
 * forbid status polling (`list_agents`), but neither says the fact a model needs
 * before it decides how to wait: a settlement reaches an *idle* session as a new
 * turn. Without it the only way to hold a turn open is a `bash` sleep, and a
 * background sleep is itself a job whose completion notice wakes the session —
 * so the model builds alarm clocks that fire after the subagent already
 * answered, turning one delegation into several turns with nothing to do.
 *
 * The text therefore states the missing fact and names the anti-pattern, and
 * stops there: the notice itself and "no need to keep checking" are already in
 * the tool descriptions, and repeating them would cost prompt tokens on every
 * turn. See the README's *global prompt addenda* section for the session
 * evidence behind the wording.
 */
export const DEFAULT_TEXT =
	"Waiting on a delegated subagent needs no polling: if it settles while you are idle, " +
	"the runtime wakes you with a new turn, so ending your turn is a valid way to wait. " +
	"Do not hold a turn open with `sleep`, background timers, or repeated `list_agents` " +
	"checks; keep one bounded timer only as a watchdog for a child that looks stuck, and " +
	"then `interrupt_agent` it.";

/**
 * The writing paragraph: in a document, the headings carry the structure and the
 * prose does not announce it.
 *
 * The case behind it is a troubleshooting note whose introduction opened by
 * previewing its own three-part organization — in a file that had *already* lost
 * the sentence naming the session it came from. Both are one defect: the text
 * described the report that produced it instead of the subject it documents. A
 * reader does not need to be told which sections follow (they are right there),
 * and a preview goes stale the moment a section moves.
 *
 * Hence the deletion test rather than a ban on a category of sentence. An
 * orientation line that carries scope or a prerequisite — "this assumes a pnpm
 * 12 store" — survives, because removing it loses something the headings do not
 * give. Prose that narrates its own structure never passes the test. See the
 * README's *global prompt addenda* section for the case and for what one
 * paragraph is meant to buy.
 */
export const DEFAULT_WRITING_TEXT =
	"When you write or edit a document, note, or report, let headings carry its structure " +
	"and never announce it in prose: delete any sentence that describes how the text is " +
	"organized or previews its outline, keep one only if removing it loses something the " +
	"headings do not already give, and leave no trace of the report or conversation the " +
	"text came from.";

// cordis plugin: the config on this plugin's row in the bundle patch
// (node_src/dotdsh/cordis.patch.yml) is passed through to apply(ctx, config).
// The plugin name follows dsh's convention (package name minus scope and
// prefix).
export const name = "agent-prompt";

/**
 * The section registry is the one hard dependency: without it this plugin has
 * nothing to contribute, and a composition that lacks it should leave the row
 * pending rather than mount a no-op.
 */
export const inject = ["systemPrompt"];

/** Prompt-addendum configuration, one knob per section. */
export interface Config {
	/**
	 * The waiting paragraph appended to the system prompt of every agent in this
	 * composition. Empty text contributes no section at all (the renderer drops
	 * empty sections), which is how a profile can neutralise this row without
	 * disabling it. Kept as config rather than a constant so a deployment can
	 * reword it in the profile's own patch — the same layer that carries every
	 * other plugin's knobs — instead of editing this package.
	 */
	text: string;

	/**
	 * The writing paragraph, with the same contract as {@link Config.text} and
	 * its own knob: a deployment that wants the writing rule gone sets this to
	 * `""` and keeps the waiting paragraph, which one shared text could not
	 * express.
	 */
	writingText: string;
}

/** Schemastery configuration for the agent-prompt plugin. */
export const Config = z.object({
	text: z.string().default(DEFAULT_TEXT),
	writingText: z.string().default(DEFAULT_WRITING_TEXT),
});

/**
 * The section name this package registers for the waiting paragraph.
 *
 * Section names are unique registry keys, and a scoped section shadows a global
 * one of the same name, so the name is namespaced to this bundle rather than a
 * generic word another plugin could claim.
 */
export const SECTION_NAME = "dotdsh:agent-prompt";

/** The section name this package registers for the writing paragraph. */
export const WRITING_SECTION_NAME = "dotdsh:agent-prompt-writing";

/**
 * Where each paragraph lands and which config knob feeds it.
 *
 * The anchors are the guidance each paragraph corrects: the waiting one sits at
 * the subagent tool's own slot, beside the description that withholds the
 * idle-wake fact, and the writing one at the write tool's slot, where the model
 * is about to produce document text.
 */
interface Addendum {
	readonly sectionName: string;
	readonly anchor: PromptSectionOrderName;
	readonly text: (config: Config) => string;
}

const ADDENDA: readonly Addendum[] = [
	{ sectionName: SECTION_NAME, anchor: "TOOL_SUBAGENT", text: (config) => config.text },
	{ sectionName: WRITING_SECTION_NAME, anchor: "TOOL_WRITE", text: (config) => config.writingText },
];

/**
 * Register both addenda for every agent in the composition.
 *
 * Each section is independent: its own name, its own anchor, its own knob. The
 * order is the tool's own slot so the paragraph lands beside the guidance it
 * corrects rather than in the deployment persona. `interpolate: false` keeps the
 * text literal: it is prose a human may reword through the config, and a stray
 * `{{` in that prose must not fail an assembly.
 */
export function apply(ctx: Context, config: Config): void {
	for (const { sectionName, anchor, text } of ADDENDA) {
		const section: PromptSection = {
			name: sectionName,
			order: ctx.systemPrompt.getSectionOrder(anchor),
			text: text(config),
			interpolate: false,
		};
		ctx.systemPrompt.section(section);
	}
}
