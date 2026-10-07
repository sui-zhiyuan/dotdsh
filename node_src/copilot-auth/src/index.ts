import type { Context } from "@deepseek-ai/cordis";
import type { AuthorizationService } from "@deepseek-ai/dsh-authorization";
import z from "@deepseek-ai/schemastery";
import { registerCopilotCommands } from "./commands.js";
import { COPILOT_PROVIDER_ID, COPILOT_RECORD_KEY } from "./constants.js";
import { beginCopilotSignIn } from "./seam.js";

// The package's public surface. `registerCopilotCommands` is exported because
// its dependencies are injected rather than reached for: that is what lets the
// committed checks drive every sign-in branch against a fake seam instead of a
// live dsh, and what lets a deployment wire a different transport without
// patching this plugin. `beginCopilotSignIn` is the runner that surface is
// normally wired with.
export { registerCopilotCommands, type CommandRegistry, type CopilotCommandOptions } from "./commands.js";
export { COPILOT_PROVIDER_ID, COPILOT_RECORD_KEY, OFFICIAL_PROXY_HOST } from "./constants.js";
export { validateGrant, jsonImage, type CopilotGrant } from "./grant.js";
export { beginCopilotSignIn, CopilotSignInError, type CopilotSignInRequest, type LoginNotice } from "./seam.js";

// cordis plugin: the config on this plugin's row in the bundle patch
// (node_src/dotdsh/cordis.patch.yml) is passed through to apply(ctx, config).
// The plugin name follows dsh's convention (package name minus scope and prefix).
export const name = "copilot-auth";

/**
 * The credential store is the one hard dependency: the commands that report on
 * a sign-in and remove it would have nothing to act on without it. `commands`,
 * `llm` and `authorization` are reached through `ctx.inject` / `ctx.get`
 * instead, so a headless or minimal composition that composes none of them
 * still mounts this plugin — it simply offers no command surface, or a login
 * that reports the missing seam.
 */
export const inject = ["credentials"];

/** Copilot sign-in configuration. */
export interface Config {
  /**
   * How long one sign-in attempt may take, in milliseconds, before it aborts
   * itself. Pi-ai's device code is valid for 15 minutes at GitHub, so the
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
 * `ctx.authorization` is read per call rather than captured at mount, for two
 * reasons: the service belongs to a composed graph that can unload and reload
 * under this row, and a composition without it must still mount — status and
 * logout only need the credential store, while login reports that dsh has no
 * flow to begin rather than failing the whole plugin.
 *
 * @param ctx - the plugin context, carrying the credential service.
 * @param config - the row's configuration.
 */
export function apply(ctx: Context, config: Config = Config({})): void {
  const resolved = Config(config);
  /** The seam as this composition currently exposes it; absent is a valid state. */
  const authorizationOf = (): AuthorizationService | undefined =>
    ctx.get("authorization") as AuthorizationService | undefined;
  ctx.inject(["commands"], (scoped) => {
    scoped.effect(
      () =>
        registerCopilotCommands(scoped.commands, {
          credentials: ctx.credentials,
          login: (request) => beginCopilotSignIn(authorizationOf(), request),
          loginWindowMs: resolved.loginWindowMs,
          // Read per call, not captured: the route set follows the user's
          // settings and changes while dsh runs, so a status line that cached
          // its answer would report the moment dsh started rather than now.
          routeConfigured: () =>
            ctx.get("llm")?.listProviders().some((entry) => entry.id === COPILOT_PROVIDER_ID) ?? false,
          // Same reason: whether a flow is registered for this record is a fact
          // about the currently composed graph, not about boot.
          flowRegistered: () => authorizationOf()?.describe(COPILOT_RECORD_KEY) !== undefined,
          warn: (message, error) => {
            ctx.logger.warn(message);
            ctx.logger.warn(error instanceof Error ? (error.stack ?? error.message) : String(error));
          },
        }),
      "copilot-auth: human sign-in commands",
    );
  });
}
