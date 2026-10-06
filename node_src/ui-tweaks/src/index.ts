// dotdsh UI tweaks — node half.
//
// This package is dual-face: the row the Loader mounts is THIS file, while every
// tweak ships through `exports["./client"]` (client/index.js). The row is what
// makes dsh's client-modules scan pick the package up among the active Loader
// entries and add its browser half to the boot graph.
//
// This half owns exactly one thing: the tweak set's configuration. A browser half
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
//
// The settings domain hands this half one live reference per field, so an edit
// reaches a page without a restart. A composition with no settings domain still
// mounts the row: the references then answer the schema defaults, and the
// browser half keeps its own copy of the page-owned defaults.
//
// Layers: this file wires; `settings.ts` is pure data. No lower layer may import
// a higher one.

import type { Context } from "@deepseek-ai/cordis";
import type { Config } from "./settings.js";

// cordis plugin: the name follows dsh's convention (package name minus scope and
// prefix: @dsh-external/dotdsh-ui-tweaks → ui-tweaks).
export const name = "ui-tweaks";

export { Config, SETTINGS_NAMESPACE } from "./settings.js";
export type { Config as UiTweaksConfig } from "./settings.js";

/**
 * Mount the row.
 *
 * There is nothing to wire: the settings form is this entry's own `Config`
 * schema, which the settings domain reads straight off the Loader entry because
 * every field is `.volatile()` (see `settings.ts`). Nothing here has to cope with
 * a user layer that does not fit it either — a value the schema rejects never
 * reaches the plugin: the Settings page refuses the write, and a hand-edited patch
 * fails this row at boot with the field named rather than leaving a switch that
 * looks set.
 *
 * @param _ctx - host context; unused, because this half needs no host service.
 * @param _config - this row's config: one live reference per field.
 */
export function apply(_ctx: Context, _config: Config): void {}
