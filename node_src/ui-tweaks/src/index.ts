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
// that does reach a page: the settings form. Every field of this row's `Config`
// schema is `.volatile()`, which is what the settings domain reads to expose the
// entry under its Loader id, and the browser half asks the client settings
// transport for that same id. The RESOLVED section — schema default under this
// row's `config` under the user layer — is what the tweaks read:
//
//   # $DSH_HOME/profiles/<name>/cordis.patch.yml, the user layer, written by the
//   # Settings page (or by hand); the row's own `config` in the bundle patch is
//   # the layer underneath it.
//   - id: ui-tweaks
//     config:
//       composerEnterNewline: true
//       statusWording: true
//       statusPhrases: ["自定义一句"]
//       openInVscode: true
//       editorCommand: code
//
// The settings domain hands this half one live reference per field, so an edit
// reaches a page (and the routes below) without a restart. A composition with no
// settings domain still mounts the row: the references then answer the schema
// defaults, and the browser half keeps its own copy of the page-owned defaults.
//
// The open-in-editor routes are the exception to "the page owns its tweak": a
// browser half cannot spawn a process, so this half serves two web routes and the
// page asks them whether a Ctrl/Cmd+click is interceptable at all. Those routes
// read the SAME live references, so the switch and the command have exactly one
// definition.
//
// Layers, and which may import which: this file wires; `open-in-vscode.ts` owns
// the wire contract, the security fence and the routes and imports
// `editor-launch.ts` and `settings.ts`; `editor-launch.ts` owns the
// filesystem/process work and imports only the configuration type;
// `settings.ts` is pure data. No lower layer may import a higher one.

import type { Context } from "@deepseek-ai/cordis";
import { openInEditorRoutes } from "./open-in-vscode.js";
import type { Config } from "./settings.js";

// cordis plugin: the name follows dsh's convention (package name minus scope and
// prefix: @dsh-external/dotdsh-ui-tweaks → ui-tweaks).
export const name = "ui-tweaks";

// The route carrier and the trust fence, as hard dependencies: a composition that
// cannot serve routes cannot serve this browser half's requests either, so
// parking the row until they arrive is the honest outcome. The settings domain is
// no longer a dependency at all — the form is this entry's own schema, read by
// the domain, and the live field references arrive as `config`.
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
 * Register the open-in-editor routes.
 *
 * There is nothing else to wire: the settings form is this entry's own `Config`
 * schema, which the settings domain reads straight off the Loader entry because
 * every field is `.volatile()` (see `settings.ts`). No registration call, no
 * optional settings dependency, and nothing here to fail when a user layer does
 * not fit the schema — a value the schema rejects never reaches the plugin, and
 * the field falls back to the layer below it.
 *
 * @param ctx - host context carrying `webServer` and `connection`.
 * @param config - this row's config: one live reference per field.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(
    () => openInEditorRoutes(ctx, config),
    "ui-tweaks: register the open-in-editor routes",
  );
}
