import type { Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { registerCopilotCommands } from "./commands.js";
import { COPILOT_PROVIDER_ID } from "./constants.js";
import { loginCopilot } from "./login.js";

// The package's public surface. `registerCopilotCommands` is exported because
// its dependencies are injected rather than reached for: that is what lets the
// committed checks drive every sign-in branch against a fake flow instead of
// github.com, and what lets a deployment wire a different transport (a proxy, a
// test double) without patching this plugin.
export { registerCopilotCommands, type CommandRegistry, type CopilotCommandOptions } from "./commands.js";
export { COPILOT_PROVIDER_ID, COPILOT_RECORD_KEY, OFFICIAL_PROXY_HOST } from "./constants.js";
export { validateGrant, jsonImage, type CopilotGrant } from "./grant.js";
export { loginCopilot, CopilotAuthError, type LoginNotice, type LoginRequest } from "./login.js";

// cordis plugin: the config on this plugin's row in the bundle patch
// (node_src/dotdsh/cordis.patch.yml) is passed through to apply(ctx, config).
// The plugin name follows dsh's convention (package name minus scope and prefix).
export const name = "copilot-auth";

/**
 * The credential store is the one hard dependency: a sign-in that cannot be
 * stored is not a sign-in, and the commands that report on it would have
 * nothing to report. `commands` and `llm` are reached through `ctx.inject` /
 * `ctx.get` instead, so a headless or minimal composition that composes neither
 * still mounts this plugin — it simply offers no command surface.
 */
export const inject = ["credentials"];

/** Copilot sign-in configuration. */
export interface Config {
  /**
   * How long one sign-in attempt may take, in milliseconds, before it aborts
   * itself. The device-code grant is valid for 15 minutes at GitHub, so the
   * default is that window with slack; a smaller value is for an unattended
   * machine where a stuck attempt should not outlive the turn that started it.
   */
  loginWindowMs: number;
}

/** Schemastery configuration for the copilot-auth plugin. */
export const Config = z.object({
  loginWindowMs: z.number().min(1_000).max(3_600_000).default(180_000),
});

/**
 * Register the human-facing `/copilot-login`, `/copilot-status` and
 * `/copilot-logout` commands.
 *
 * Nothing model-callable is registered anywhere in this plugin: the sign-in is
 * a human typing a command, which is what keeps a prompt-injected model from
 * starting a device-code authorization or dropping a stored grant.
 *
 * @param ctx - the plugin context, carrying the credential service.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const resolved = Config(config);
  ctx.inject(["commands"], (scoped) => {
    scoped.effect(
      () =>
        registerCopilotCommands(scoped.commands, {
          credentials: ctx.credentials,
          login: loginCopilot,
          loginWindowMs: resolved.loginWindowMs,
          // Read per call, not captured: the route set follows the user's
          // settings and changes while dsh runs, so a status line that cached
          // its answer would report the moment dsh started rather than now.
          routeConfigured: () =>
            ctx.get("llm")?.listProviders().some((entry) => entry.id === COPILOT_PROVIDER_ID) ?? false,
          warn: (message, error) => {
            ctx.logger.warn(message);
            ctx.logger.warn(error instanceof Error ? (error.stack ?? error.message) : String(error));
          },
        }),
      "copilot-auth: human sign-in commands",
    );
  });
}
