/**
 * The composition root: what dsh calls when it mounts this plugin.
 *
 * `apply` is the only place that names every contribution at once. Each of the
 * other modules exports what it owns and knows nothing about the rest —
 * {@link GIT_FLOW_COMMANDS}, {@link GIT_FLOW_TOOLS} and
 * {@link GIT_FLOW_INTERCEPTOR} are lists and values a wiring step registers, and
 * `createSkillProvider` builds the provider the skill registry pulls from.
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
 * | `createSkillProvider(settings)` | `ctx.skills.registerProvider` — two bundled skills |
 *
 * ## Where the configuration enters
 *
 * Here, and nowhere else. The row's `config` reaches a plugin as this function's
 * second argument — it is not a service and nothing below can ask for it later —
 * so {@link resolveSettings} is called once, at mount, and the result is closed
 * over by the registrations below: every handler, every tool, the interceptor and
 * the skill provider are handed the same resolved object. A setting a row got
 * wrong therefore fails the mount rather than the first operation that trips over
 * it.
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
import z from "@deepseek-ai/schemastery";
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import { GIT_FLOW_COMMANDS } from "./boundary/commands.js";
import { GIT_FLOW_INTERCEPTOR } from "./boundary/guard.js";
import { createSkillProvider } from "./boundary/skill.js";
import { GIT_FLOW_TOOLS } from "./boundary/tools.js";
import { DEFAULT_FLOW_SETTINGS, resolveSettings } from "./platform/settings.js";

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
 * git-flow's configuration, as the row supplies it.
 *
 * Every key is optional in practice — the schema below defaults each one — and the
 * resolved, validated shape every layer below reads is `FlowSettings`. See
 * `platform/settings.ts` for what each setting means and what a value has to look
 * like.
 */
export interface Config {
  /** Prefix for feature branches, with or without its trailing slash. */
  branchPrefix: string;
  /** The branch a feature branch is cut from and merged back into. */
  integrationBranch: string;
  /** Worktree root, relative to the repository's main working tree. */
  worktreeRoot: string;
  /** The claim file, relative to the repository's main working tree. */
  claimFile: string;
  /** How old the claim file's lock may be before another process takes it over. */
  lockStaleSeconds: number;
  /** How old a claim may be before a sweep collects it. */
  sweepAgeHours: number;
  /** The longest a feature branch's subject may be, after the prefix. */
  branchSubjectMaxLength: number;
  /** Whether the pre-write guard runs. */
  guard: "on" | "off";
}

/**
 * Schemastery configuration for the git-flow plugin.
 *
 * The defaults come from {@link DEFAULT_FLOW_SETTINGS} rather than being written
 * again here, and `resolveSettings` fills the same values for a row that supplies
 * nothing — one source for all three.
 */
export const Config: z<Config> = z.object({
  branchPrefix: z.string().default(DEFAULT_FLOW_SETTINGS.branchPrefix),
  integrationBranch: z.string().default(DEFAULT_FLOW_SETTINGS.integrationBranch),
  worktreeRoot: z.string().default(DEFAULT_FLOW_SETTINGS.worktreeRoot),
  claimFile: z.string().default(DEFAULT_FLOW_SETTINGS.claimFile),
  lockStaleSeconds: z.number().default(DEFAULT_FLOW_SETTINGS.lockStaleSeconds),
  sweepAgeHours: z.number().default(DEFAULT_FLOW_SETTINGS.sweepAgeHours),
  branchSubjectMaxLength: z.number().default(DEFAULT_FLOW_SETTINGS.branchSubjectMaxLength),
  guard: z.union([z.const("on"), z.const("off")]).default(DEFAULT_FLOW_SETTINGS.guard),
});

/**
 * Register everything this plugin contributes, for the settings this row supplies.
 *
 * One pass over four things, each with its own disposer:
 *
 * 1. every command definition in {@link GIT_FLOW_COMMANDS};
 * 2. every tool definition in {@link GIT_FLOW_TOOLS};
 * 3. the single interception in {@link GIT_FLOW_INTERCEPTOR} — the pre-write
 *    guard listens on the harness's `tools/pre-execute` waterfall, so it is
 *    removed by the same disposer discipline as everything else;
 * 4. the skill provider, which serves both of the package's skills and reads a
 *    body from its asset only when a model actually loads one.
 *
 * Each of them is handed the resolved settings through a closure, which is the
 * only place they can come from: the harness passes a row's configuration to this
 * function and never exposes it again.
 *
 * @param ctx - the plugin context, with `commands`, `skills` and `tools` injected.
 * @param config - the row's configuration; omitted keys take their defaults.
 * @throws Error when a setting cannot be honoured — at mount, not at first use.
 */
export function apply(ctx: Context, config: Config): void {
  const settings = resolveSettings(config);

  for (const command of GIT_FLOW_COMMANDS) {
    ctx.effect(() =>
      ctx.commands.register({
        ...command.descriptor,
        handler: (invocation) => command.handler(invocation, settings),
      }),
    );
  }

  for (const tool of GIT_FLOW_TOOLS) {
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          ...tool.descriptor,
          // `ToolSchema` carries the arguments as a bare `Record`, because the
          // LLM layer only ever projects them to JSON Schema. Only here, where
          // they are handed to the registry that compiles and enforces them, is
          // their real author-facing shape known.
          parameters: tool.descriptor.parameters as ParameterSchemaSpec,
          // The declaration `ToolSchema` cannot carry: every tool answers with
          // one text block, which is what the model reads.
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          // `GIT_FLOW_TOOLS` is a `GitFlowTool<never>[]` so entries with
          // different argument objects share one list, and its elements expose
          // no argument type to recover; the registry has already validated the
          // call against the very descriptor spread above.
          execute: (args, execution) => tool.execute(args as never, execution, settings),
        }),
      ),
    );
  }

  ctx.effect(() =>
    ctx.on(GIT_FLOW_INTERCEPTOR.hook, (execution, next) =>
      GIT_FLOW_INTERCEPTOR.handle(execution, next, settings),
    ),
  );

  ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(settings)));
}
