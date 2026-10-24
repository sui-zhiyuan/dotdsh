import type { Context } from "@deepseek-ai/cordis";
import type { PromptSection } from "@deepseek-ai/dsh-system-prompt";
import z from "@deepseek-ai/schemastery";

/**
 * The one paragraph this package adds to every agent's system prompt.
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
 * turn. See the README's *global prompt addendum* section for the session
 * evidence behind the wording.
 */
export const DEFAULT_TEXT =
	"Waiting on a delegated subagent needs no polling: if it settles while you are idle, " +
	"the runtime wakes you with a new turn, so ending your turn is a valid way to wait. " +
	"Do not hold a turn open with `sleep`, background timers, or repeated `list_agents` " +
	"checks; keep one bounded timer only as a watchdog for a child that looks stuck, and " +
	"then `interrupt_agent` it.";

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

/** Prompt-addendum configuration. */
export interface Config {
	/**
	 * The paragraph appended to the system prompt of every agent in this
	 * composition. Empty text contributes no section at all (the renderer drops
	 * empty sections), which is how a profile can neutralise this row without
	 * disabling it. Kept as config rather than a constant so a deployment can
	 * reword it in the profile's own patch — the same layer that carries every
	 * other plugin's knobs — instead of editing this package.
	 */
	text: string;
}

/** Schemastery configuration for the agent-prompt plugin. */
export const Config = z.object({
	text: z.string().default(DEFAULT_TEXT),
});

/**
 * The section name this package registers.
 *
 * Section names are unique registry keys, and a scoped section shadows a global
 * one of the same name, so the name is namespaced to this bundle rather than a
 * generic word another plugin could claim.
 */
export const SECTION_NAME = "dotdsh:agent-prompt";

/**
 * Register the addendum for every agent in the composition.
 *
 * The order is the subagent tool's own slot, so the paragraph lands beside the
 * guidance it corrects rather than in the deployment persona. `interpolate:
 * false` keeps the text literal: it is prose a human may reword through
 * `config.text`, and a stray `{{` in that prose must not fail an assembly.
 */
export function apply(ctx: Context, config: Config): void {
	const section: PromptSection = {
		name: SECTION_NAME,
		order: ctx.systemPrompt.getSectionOrder("TOOL_SUBAGENT"),
		text: config.text,
		interpolate: false,
	};
	ctx.systemPrompt.section(section);
}
