// The ui-tweaks settings contract: the row schema whose volatile fields the
// settings domain exposes as the `ui-tweaks` form, and the plain value shape the
// route layer reads out of it.
//
// Layer: pure data. It imports the schema library and the cordis `Volatile`
// reference type and nothing else, so the route layer, the launcher and the
// plugin wiring can all describe their required configuration in terms of
// {@link Config} without depending on each other.
//
// ## How a plugin has settings since dsh 0.2.0-rc.2
//
// A plugin no longer REGISTERS a namespace with the settings service:
// `ctx.settings.register(ns, schema, {base})` and `ctx.settings.get(ns)` are gone.
// The Loader entry's own `Config` schema is the form now, and only fields marked
// `.volatile()` are exposed as editable — a row whose schema has no volatile
// field has no settings page at all. The service passes the plugin a LIVE
// reference per volatile field (`config.<field>.get()`), and that reference is
// what replaces the old per-request `get(ns)` read: it always answers the
// resolved value, schema default under the row's own `config` under the user
// layer, and it is updated in place when the user layer changes.
//
// The form's namespace is the Loader entry id — the patch row's `id` — which is
// why {@link SETTINGS_NAMESPACE} still spells `ui-tweaks`: the browser half asks
// the client settings transport for the same entry id (`configForms.get(...)`).
// The user layer now lives in the profile patch (`$DSH_HOME/profiles/<name>/
// cordis.patch.yml`, written by the settings UI), not in `$DSH_HOME/settings.yaml`,
// which dsh 0.2.0-rc.2 imports into the profile once and renames.

import type { Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

/**
 * Settings namespace both halves of this package share: the Loader entry id of
 * the `ui-tweaks` row (`node_src/dotdsh/cordis.patch.yml`). The node half's
 * volatile `Config` is exposed under it and the browser half reads it through
 * `configForms.get(...)`; it is the only channel a row's config has to a page.
 */
export const SETTINGS_NAMESPACE = "ui-tweaks";

/**
 * The resolved values the tweak set acts on: what a volatile reference's `get()`
 * answers, and the shape the browser half validates an accepted section against.
 *
 * `openInVscode` and `editorCommand` are deliberately not mirrored by the page's
 * own settings seed: they are enforced by the host routes, which are the only
 * side that can act on them, so a page copy could only disagree with the
 * authority. `test/verify-host.mjs` pins which fields each side reads.
 */
export interface SettingsValues {
  /**
   * Bare Enter breaks the line in the composer and Ctrl/Cmd+Enter sends. `false`
   * keeps dsh's shipped composer keymap, where plain Enter sends.
   */
  composerEnterNewline: boolean;
  /**
   * While a turn runs, the Chinese chat status line shows a randomly drawn
   * phrase instead of the shipped "深度求索中...". A running line that appends the
   * elapsed time keeps that part ("…，用时 3 秒 ···"), so only the wording ahead of
   * it changes and the timer, the shimmer and the whale tail stay as dsh ships
   * them. The shipped bank is Chinese, so an English UI keeps its own copy either
   * way.
   */
  statusWording: boolean;
  /**
   * Phrases appended to the bank this package ships, drawn with the same chance
   * as the built-ins. Blank entries are dropped by the page that reads them.
   */
  statusPhrases: string[];
  /**
   * Ctrl/Cmd+click on a workspace file opens it in the configured editor instead
   * of in dsh's own preview. Off leaves every click to dsh.
   */
  openInVscode: boolean;
  /**
   * The editor's command: ONE bare name resolved on the host's PATH (`code`) or
   * ONE absolute executable path. Not a command line — arguments are this
   * package's business, and accepting spaces would turn a typo into a silently
   * truncated path. The WSL launcher that ships with VS Code (`.../bin/code`) is
   * a shell script, so a bare name is the normal setting, not a limitation.
   */
  editorCommand: string;
}

/**
 * Configuration this row's `apply` receives: one live reference per field.
 *
 * The references are stable for the life of the row — the settings domain
 * updates them in place rather than re-applying the plugin — so a handler that
 * needs the current value calls `get()` where it needs it (per request, per
 * click) instead of capturing a value at registration time.
 */
export interface Config {
  composerEnterNewline: Volatile<boolean>;
  statusWording: Volatile<boolean>;
  statusPhrases: Volatile<string[]>;
  openInVscode: Volatile<boolean>;
  editorCommand: Volatile<string>;
}

/**
 * Schemastery configuration for the ui-tweaks row: schema defaults, then the
 * row's own `config` in the bundle patch (which `dev_apply` links and the
 * deployment may override in its profile layer), then the user layer the
 * settings UI writes into the profile patch.
 *
 * Every field is `.volatile()`, which is what puts it on the settings form and
 * what makes the value the plugin reads follow an edit without a restart. Its
 * serialized form is also the wire envelope the browser half's section is
 * validated against, which is why the browser half's seed mirrors the three
 * page-owned defaults below (see the note on {@link SettingsValues}).
 */
export const Config = z.object({
  composerEnterNewline: z.boolean().default(true).volatile(),
  statusWording: z.boolean().default(true).volatile(),
  statusPhrases: z.array(z.string()).default([]).volatile(),
  openInVscode: z.boolean().default(true).volatile(),
  editorCommand: z.string().default("code").volatile(),
});
