/**
 * The composition root: what dsh calls when it mounts this plugin.
 *
 * `apply` is the only place that names every contribution at once. Each of the
 * other modules exports what it owns and knows nothing about the rest —
 * {@link GIT_FLOW_COMMANDS}, {@link GIT_FLOW_TOOLS} and
 * {@link GIT_FLOW_INTERCEPTOR} are lists and values a wiring step registers, and
 * {@link GIT_FLOW_SKILL_PROVIDER} is a provider the skill registry pulls from.
 * Adding a fourth command, then, is a change in exactly one file: this one does
 * not enumerate anything, it iterates.
 *
 * Every registration is owned by `ctx.effect`, so a reload, a disable or an
 * unmount takes all of them away with it. A plugin that registers without owning
 * the registration leaks a command or a listener into the next composition.
 *
 * ## What it registers
 *
 * | Contribution | Where |
 * | --- | --- |
 * | every entry of `GIT_FLOW_COMMANDS` | `ctx.commands.register` |
 * | every entry of `GIT_FLOW_TOOLS` | `ctx.tools.register` |
 * | `GIT_FLOW_INTERCEPTOR` | `ctx.on("tools/pre-execute", …)` |
 * | `GIT_FLOW_SKILL_PROVIDER` | `ctx.skills.registerProvider` — two bundled skills |
 *
 * The services come from the agent rather than from here: a handler asks its own
 * agent for the process seam and the session store, so this plugin injects only
 * what it registers *into*. A busy session's tool call and a boot-time
 * registration reach the runtime by different routes, and only one of them
 * belongs to the composition root.
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` and `platform` are both fair game — and
 * never upward: nothing below this layer may import it.
 *
 * @module @dsh-external/dotdsh-git-flow
 */

import type { Context } from "@deepseek-ai/cordis";
import { GIT_FLOW_COMMANDS } from "./boundary/commands.js";
import { GIT_FLOW_INTERCEPTOR } from "./boundary/guard.js";
import { GIT_FLOW_SKILL_PROVIDER } from "./boundary/skill.js";
import { GIT_FLOW_TOOLS } from "./boundary/tools.js";

/** The plugin name, following dsh's convention: the package name minus scope and prefix. */
export const name = "git-flow";

/**
 * The services this plugin registers into.
 *
 * Named explicitly so a composition missing one fails here — at the row that
 * mounts this plugin — rather than at the first command a session tries to run.
 */
export const inject = ["commands", "skills", "tools"];

/**
 * Register everything this plugin contributes.
 *
 * One pass over four things, each with its own disposer:
 *
 * 1. every command definition in {@link GIT_FLOW_COMMANDS};
 * 2. every tool definition in {@link GIT_FLOW_TOOLS};
 * 3. the single interception in {@link GIT_FLOW_INTERCEPTOR} — the pre-write
 *    guard listens on the harness's `tools/pre-execute` waterfall, so it is
 *    removed by the same disposer discipline as everything else;
 * 4. {@link GIT_FLOW_SKILL_PROVIDER}, which serves both of the package's skills
 *    and reads a body from its asset only when a model actually loads one.
 *
 * @param ctx - the plugin context, with `commands`, `skills` and `tools` injected.
 */
export function apply(ctx: Context): void {
  throw new Error("apply is not implemented");
}
