// The ui-tweaks settings contract: the schema the node half registers with the
// settings service, and the shape both halves validate the resolved section
// against.
//
// Layer: pure data. It imports nothing but the schema library, so the route
// layer, the launcher and the plugin wiring can all describe their required
// configuration in terms of {@link Config} without depending on each other.

import z from "@deepseek-ai/schemastery";

/**
 * Settings namespace both halves of this package share. The node half registers
 * it (src/index.ts) and the browser half binds a scope over it
 * (client/index.js); it is the only channel a row's config has to a page.
 */
export const SETTINGS_NAMESPACE = "ui-tweaks";

/**
 * Configuration of the tweak set: one switch per tweak, plus the extra wording
 * and the editor command.
 *
 * The browser half mirrors the PAGE-OWNED field names — and their defaults — in
 * its own settings seed (`client/index.js`), because a page cannot read its row's
 * config: the boot graph carries no config, so the settings namespace is the one
 * channel. `openInVscode` and `editorCommand` are deliberately NOT mirrored: they
 * are enforced by the host routes, which are the only side that can act on them,
 * so a page copy could only disagree with the authority. `test/verify-host.mjs`
 * pins which fields each side reads.
 */
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
 * Schemastery configuration for the ui-tweaks row: schema defaults, then the
 * row's `config` as the settings `base` layer, then the user layer in
 * `$DSH_HOME/settings.yaml`. Its serialized form is also the wire envelope the
 * browser scope validates the resolved section against, which is why the browser
 * half's seed mirrors the three page-owned defaults below (see the note above).
 */
export const Config: z<Config> = z.object({
  composerEnterNewline: z.boolean().default(true),
  statusWording: z.boolean().default(true),
  statusPhrases: z.array(z.string()).default([]),
  openInVscode: z.boolean().default(true),
  editorCommand: z.string().default("code"),
});
