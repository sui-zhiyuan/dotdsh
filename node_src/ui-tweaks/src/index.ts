// dotdsh UI tweaks — node half.
//
// This package is dual-face: the row the Loader mounts is THIS file, while every
// tweak ships through `exports["./client"]` (client/index.js). The row is what
// makes dsh's client-modules scan pick the package up among the active Loader
// entries and add its browser half to the boot graph.
//
// What this half owns is the tweak set's configuration and the one tweak that
// cannot live in a page: opening a clicked file in a local editor. A browser half
// cannot read its row's `config` (the boot graph carries id/url/rev/inject/
// external/immediately and no config), so the two halves meet on the one channel
// that does reach a page: a settings namespace. `apply` registers `ui-tweaks`
// with the row's config as the composition `base` layer, the browser half binds a
// scope over that namespace, and the RESOLVED section — that base under the user
// layer of $DSH_HOME/settings.yaml — is what the tweaks read:
//
//   ui-tweaks:
//     composerEnterNewline: true
//     statusWording: true
//     statusPhrases: ["自定义一句"]
//     openInVscode: true
//     editorCommand: code
//
// The settings file provider watches its document, so such an edit reaches the
// page without a restart. Without a provider nothing is registered and the
// browser half keeps the same defaults this schema declares.
//
// The open-in-editor routes are the exception to "the page owns its tweak": a
// browser half cannot spawn a process, so this half serves two web routes and the
// page asks them whether a Ctrl/Cmd+click is interceptable at all. Those routes
// read the SAME settings namespace, so the switch and the command have exactly
// one definition.
//
// Layers, and which may import which: this file wires; `open-in-vscode.ts` owns
// the wire contract, the security fence and the routes and imports
// `editor-launch.ts` and `settings.ts`; `editor-launch.ts` owns the
// filesystem/process work and imports only the configuration type;
// `settings.ts` is pure data. No lower layer may import a higher one.

import type { Context } from "@deepseek-ai/cordis";
// Type-only, and deliberately value-free: `@deepseek-ai/dsh-settings` is what
// declares `Context.settings`, and the service itself arrives through `inject`.
import type {} from "@deepseek-ai/dsh-settings";
import { openInEditorRoutes } from "./open-in-vscode.js";
import { Config, SETTINGS_NAMESPACE } from "./settings.js";

// cordis plugin: the name follows dsh's convention (package name minus scope and
// prefix: @dsh-external/dotdsh-ui-tweaks → ui-tweaks).
export const name = "ui-tweaks";

// The route carrier and the trust fence, as hard dependencies: a composition that
// cannot serve routes cannot serve this browser half's requests either, so
// parking the row until they arrive is the honest outcome. The settings service,
// by contrast, stays optional (see `apply`).
export const inject = ["webServer", "connection"];

export { Config, SETTINGS_NAMESPACE } from "./settings.js";
export type { Config as UiTweaksConfig } from "./settings.js";
export type { EditorLaunchFailure, EditorLaunchResult } from "./editor-launch.js";
export type {
  OpenInEditorFailureResp,
  OpenInEditorLaunchReq,
  OpenInEditorLaunchedResp,
  OpenInEditorStatusResp,
} from "./open-in-vscode.js";

/**
 * Register the `ui-tweaks` settings namespace and the open-in-editor routes.
 *
 * The namespace registration goes through `ctx.inject` rather than a plugin-level
 * `inject`: the settings service is optional here, and a composition without a
 * provider must still mount this row (the browser half then runs on its own
 * defaults, and the routes read the schema defaults for their two fields).
 * Registration is an effect of the calling fiber, so unloading the row withdraws
 * the namespace again.
 *
 * The guard around the registration is the reason the raw service call is still
 * here rather than inside a helper: a stored section the schema rejects makes
 * `register` throw, throttling the whole namespace if it is allowed to reach the
 * boot — this catches it, and the page's defaults are what a broken document
 * gets.
 * @param ctx - Host context whose optional settings service owns the namespace.
 * @param config - this row's config, resolved through {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      settingsCtx.settings.register(SETTINGS_NAMESPACE, Config, { base: config });
    } catch (error) {
      // A stored section the schema rejects rejects the registration itself, and
      // the namespace then stays unregistered for the whole boot: the browser
      // half falls back to its defaults and nothing reaches the page to say why.
      // Report it through the logger the settings service itself uses, so a typo
      // in settings.yaml is at least diagnosable rather than looking like
      // switches that do nothing.
      settingsCtx.logger.warn(
        `ui-tweaks: settings namespace "${SETTINGS_NAMESPACE}" was not registered (${
          error instanceof Error ? error.message : String(error)
        }); the browser half runs on its schema defaults until the document is fixed and dsh restarts`,
      );
    }
  });
  ctx.effect(
    () => openInEditorRoutes(ctx, config),
    "ui-tweaks: register the open-in-editor routes",
  );
}
