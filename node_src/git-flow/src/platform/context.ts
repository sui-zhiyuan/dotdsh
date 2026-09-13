/**
 * What one call runs with: the plugin's settings, the process seam, and the
 * repository the call is about.
 *
 * ## Why a context rather than a longer argument list
 *
 * Every operation in this plugin needs the same three things before it can do
 * anything, and each of them used to arrive as its own positional parameter —
 * `gitStart(runner, repoRoot, sessionId, branch, …)`. The list had grown to the
 * point where a fifth argument was indistinguishable from a fourth, and every new
 * setting would have added another. A context names them once, in one shape, and a
 * function that needs one of them takes the whole thing.
 *
 * This is *this plugin's* context, not the harness's. It is plain data: a settings
 * object, a function, and a path. `core` and `platform` therefore still depend on
 * no harness package and hold no service, which is what lets the whole path be
 * driven against a scratch repository with nothing installed. Anything the context
 * carries that comes from the harness — the process seam, today — is resolved by
 * the boundary, which is the layer that talks to dsh, and handed down already
 * adapted.
 *
 * ## What belongs here, and what does not
 *
 * A field earns its place when it is the same for every call in one operation *and*
 * more than one layer needs it. The session id does not qualify: it is the argument
 * a call is about, and passing it inside the context would hide the one thing that
 * varies. Neither does anything derived — a path computed from these three is
 * computed where it is used.
 *
 * Three fields, and each is read below the boundary:
 *
 * - {@link FlowSettings} by `core` (the branch and the tree) and by `claim`
 *   (the claim file and the lock);
 * - the runner by `core`, for every git child;
 * - the repository root by both — and by `claim`, which puts its file there.
 *
 * ## Layer
 *
 * The platform: the outside world. This module is a type and nothing else, and it
 * imports nothing above it — neither `core` nor the boundary. The dependency only
 * ever points down.
 *
 * @module @dsh-external/dotdsh-git-flow/context
 */

import type { Runner } from "./exec.js";
import type { FlowSettings } from "./settings.js";

/** Everything one call to `core` runs with. */
export interface FlowContext {
  /** The plugin's resolved configuration, read from the composition row at mount time. */
  readonly settings: FlowSettings;
  /** The process seam every git call goes through. */
  readonly runner: Runner;
  /** Absolute path of the repository's **main** working tree — where the claim file lives. */
  readonly repoRoot: string;
}
