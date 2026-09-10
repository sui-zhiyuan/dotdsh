// dotdsh UI tweaks — node half.
//
// This package is dual-face: the row the Loader mounts is THIS file, while every
// tweak ships through `exports["./client"]` (client/index.js). The row is what
// makes dsh's client-modules scan pick the package up among the active Loader
// entries and add its browser half to the boot graph.
//
// What this half owns is the tweak set's configuration. A browser half cannot
// read its row's `config` (the boot graph carries id/url/rev/inject/external/
// immediately and no config), so the two halves meet on the one channel that
// does reach a page: a settings namespace. `apply` registers `ui-tweaks` with
// the row's config as the composition `base` layer, the browser half binds a
// scope over that namespace, and the RESOLVED section — that base under the user
// layer of $DSH_HOME/settings.yaml — is what the tweaks read:
//
//   ui-tweaks:
//     composerEnterNewline: true
//     statusWording: true
//     statusPhrases: ["自定义一句"]
//
// The settings file provider watches its document, so such an edit reaches the
// page without a restart. Without a provider nothing is registered and the
// browser half keeps the same defaults this schema declares.

import type { Context } from "@deepseek-ai/cordis";
// Type-only, and deliberately value-free: `@deepseek-ai/dsh-settings` is what
// declares `Context.settings`, and the service itself arrives through `inject`.
import type {} from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

// cordis plugin: the name follows dsh's convention (package name minus scope and
// prefix: @dsh-external/dotdsh-ui-tweaks → ui-tweaks).
export const name = "ui-tweaks";

/** Settings namespace both halves of this package share. */
export const SETTINGS_NAMESPACE = "ui-tweaks";

/** Configuration of the tweak set: one switch per tweak, plus the extra wording. */
export interface Config {
  /**
   * Bare Enter breaks the line in the composer and Ctrl/Cmd+Enter sends. `false`
   * keeps dsh's shipped composer keymap, where plain Enter sends.
   */
  composerEnterNewline: boolean;
  /**
   * While a turn runs, the Chinese chat status line shows a randomly drawn
   * phrase instead of the shipped "深度求索中...". The shipped bank is Chinese,
   * so an English UI keeps its own copy either way.
   */
  statusWording: boolean;
  /**
   * Phrases appended to the bank this package ships, drawn with the same chance
   * as the built-ins. Blank entries are dropped by the page that reads them.
   */
  statusPhrases: string[];
}

/**
 * Schemastery configuration for the ui-tweaks row: schema defaults, then the
 * row's `config` as the settings `base` layer, then the user layer. Its
 * serialized form is also the wire envelope the browser scope validates the
 * resolved section against, which is why the browser half's defaults mirror the
 * three defaults below.
 */
export const Config: z<Config> = z.object({
  composerEnterNewline: z.boolean().default(true),
  statusWording: z.boolean().default(true),
  statusPhrases: z.array(z.string()).default([]),
});

/**
 * Register the `ui-tweaks` settings namespace while a settings provider exists.
 *
 * `ctx.inject` rather than a plugin-level `inject`: the settings service is
 * optional here, and a composition without a provider must still mount this row
 * (the browser half then runs on its own defaults). Registration is an effect of
 * the calling fiber, so unloading the row withdraws the namespace again.
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
}
