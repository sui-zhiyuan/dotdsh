/**
 * dotdsh git-flow: the feature-branch workflow, as one dsh plugin.
 *
 * Four capabilities, all delivered from this single package and registered on one
 * patch row:
 *
 * | Requirement | Where it lives |
 * | --- | --- |
 * | `/git-start`, `/git-complete` | {@link registerCommands} — plugin-owned commands |
 * | the "global information" and the per-step commit contract | {@link registerPrompt} — one static system-prompt section |
 * | the commit-message convention | {@link registerSkill} — a bundled skill shipped as a package asset |
 * | the pre-write branch guard | {@link registerGuard} — the `tools/pre-execute` waterfall |
 * | worktree isolation for parallel sessions | `flow.ts` — driven by all of the above |
 *
 * Everything git-related sits behind the two seams in `exec.ts` and
 * `file-access.ts`, which is what lets the committed tests exercise the whole
 * branch/rebase/merge/worktree lifecycle against a scratch repository with no
 * harness present.
 *
 * @module @dsh-external/dotdsh-git-flow
 */

import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { ClaimLatch } from "./claim.js";
import { registerCommands } from "./commands.js";
import type { FlowConfig } from "./flow.js";
import { registerGuard } from "./guard.js";
import { registerPrompt } from "./prompt.js";
import { createModelNamer, subprocessRunner, type GuardMode, type ResolvedConfig, type Runtime } from "./runtime.js";
import { registerSkill } from "./skill.js";
import { GitFlowState } from "./state.js";

// The plugin name follows dsh's convention: the package name minus its scope and
// prefix.
export const name = "git-flow";

// Every service this plugin touches is named explicitly. `tools` is what carries
// the pre-execute seam, `subprocess` is the only way this plugin starts a
// process, and the other three are the surfaces it contributes to.
export const inject = ["commands", "systemPrompt", "skills", "tools", "subprocess", "sessions"];

/** git-flow plugin configuration. */
export interface Config {
  /** Prefix for feature branches, with or without its trailing slash. */
  branchPrefix: string;
  /** Integration branch name; empty means detect it from `origin/HEAD`, `main`, or `master`. */
  integrationBranch: string;
  /** Worktree root, relative to the repository's main working tree. */
  worktreeRoot: string;
  /** Whether a session that arrives while others are live is isolated in a worktree. */
  useWorktreeWhenBusy: boolean;
  /** Whether uncommitted work is committed before a merge rather than blocking it. */
  commitUncommittedBeforeMerge: boolean;
  /** Subject template for the merge commit; `{branch}` and `{integration}` are substituted. */
  mergeMessage: string;
  /** What the pre-write guard does on the integration branch. */
  guard: GuardMode;
  /** Whether the guard also covers the Bash tool. Off by default; see `guard.ts`. */
  guardBash: boolean;
}

/** Schemastery configuration for the git-flow plugin. */
export const Config: z<Config> = z.object({
  branchPrefix: z.string().default("feature/"),
  integrationBranch: z.string().default(""),
  worktreeRoot: z.string().default(".dsh.local/worktrees"),
  useWorktreeWhenBusy: z.boolean().default(true),
  commitUncommittedBeforeMerge: z.boolean().default(true),
  mergeMessage: z.string().default("Merge {branch} into {integration}"),
  guard: z.union([z.const("auto-start"), z.const("block"), z.const("off")]).default("auto-start"),
  guardBash: z.boolean().default(false),
});

/**
 * Reject settings that would make the plugin behave unsafely, at load time and
 * loudly, rather than at the moment they are used.
 *
 * A bad `worktreeRoot` is the one worth catching here: a path that escapes the
 * repository would place worktrees outside the session's workspace, where the
 * harness's own file tools may not reach them and where the ignore guard cannot
 * protect them at all.
 *
 * @param config - the resolved flow settings.
 * @throws Error when a setting cannot be honoured.
 */
function validate(config: FlowConfig): void {
  if (config.branchPrefix === "" || /\s/.test(config.branchPrefix) || config.branchPrefix.includes("..")) {
    throw new Error(`git-flow: branchPrefix ${JSON.stringify(config.branchPrefix)} is not usable as a git ref prefix`);
  }
  if (
    config.worktreeRoot === "" ||
    config.worktreeRoot.startsWith("/") ||
    config.worktreeRoot.split("/").includes("..")
  ) {
    throw new Error(
      `git-flow: worktreeRoot ${JSON.stringify(config.worktreeRoot)} must be a relative path inside the repository`,
    );
  }
  if (!config.mergeMessage.includes("{branch}")) {
    throw new Error("git-flow: mergeMessage must contain {branch} so a merge commit names the branch it merges");
  }
}

/**
 * Mount the whole plugin.
 *
 * @param ctx - the plugin context, with every service in {@link inject} available.
 * @param config - the validated row configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    branchPrefix: config.branchPrefix.endsWith("/") ? config.branchPrefix : `${config.branchPrefix}/`,
    integrationBranch: config.integrationBranch === "" ? undefined : config.integrationBranch,
    worktreeRoot: config.worktreeRoot.replace(/\/+$/, ""),
    useWorktreeWhenBusy: config.useWorktreeWhenBusy,
    commitUncommittedBeforeMerge: config.commitUncommittedBeforeMerge,
    mergeMessage: config.mergeMessage,
    guard: config.guard,
    guardBash: config.guardBash,
  };

  validate(resolved);

  const runtime: Runtime = {
    runner: subprocessRunner(ctx.subprocess),
    state: new GitFlowState(),
    config: resolved,
    pid: process.pid,
    latch: new ClaimLatch(),
    log: ctx.logger,
    sessions: ctx.sessions,
  };

  // Each contribution is registered as an effect on this plugin's fiber, so
  // unloading or reloading the plugin removes exactly what it added.
  ctx.effect(() => {
    registerSkill(ctx);
    return () => {
      // Registration disposers are owned by the service; the effect exists to
      // keep the contribution inside this plugin's lifecycle for diagnostics.
    };
  }, "git-flow: commit-message skill");

  ctx.effect(
    () => registerPrompt(ctx),
    "git-flow: workflow section",
  );

  ctx.effect(() => registerCommands(ctx, runtime), "git-flow: /git-start and /git-complete");
  ctx.effect(() => registerGuard(ctx, runtime), "git-flow: pre-write branch guard");

  // The model-backed namer, installed as an optional capability rather than a
  // precondition. It goes through a scoped `ctx.inject` and not the plugin-level
  // `inject` array for the same reason ui-tweaks reaches settings that way: a
  // profile with no model service should still get the commands, the guard, the
  // prompt contribution and the skill, and simply be asked for the branch names
  // its mechanical rules cannot derive. Declaring `llm` at plugin level would make
  // every one of those features wait for a service they do not use.
  //
  // The factory is per agent because the route is: naming runs on the model this
  // session is already using, falling back to the configured default.
  ctx.inject(["llm", "agentDefaultModel"], (scoped) => {
    runtime.namerFor = (agent) => createModelNamer(scoped, agent, undefined, scoped.logger);
    scoped.logger.info("git-flow: model-backed branch naming is available");
  });
}
