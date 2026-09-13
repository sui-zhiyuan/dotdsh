// The open-in-editor click handler, as a self-contained browser script.
//
// WHY A SECOND CLIENT FILE: `client/index.js` stays the boot-protocol
// registration the manifest names, and this file carries the behaviour, so the
// two concerns do not share one long body. `index.js` injects
// `<script src="clicked-file.js">` beside itself — the same load technique the
// module system uses for its own bundles — and reads this file's exports off the
// global it publishes below. Nothing builds or type-checks this file: it is
// plain JavaScript with no imports, and `test/verify-client.mjs` loads both files
// into a fake DOM through the same two entry points dsh uses.
//
// WHAT IT DOES, end to end:
//   1. once per page, ask the host whether the editor is available
//      (`GET /ui-tweaks/open-in-vscode/status`);
//   2. while the answer is yes, intercept Ctrl/Cmd+click on the two surfaces
//      that name a workspace file in their DOM;
//   3. build the absolute path from the clicked surface's own attribute plus the
//      current session's `cwd`, and POST it to the host;
//   4. claim the event — `preventDefault` + `stopImmediatePropagation` — so
//      dsh's own preview does not also open.
//
// WHY THE INTERCEPTION IS SYNCHRONOUS: a launch response arrives long after the
// click has finished dispatching, and cancelling a completed event does nothing.
// So the decision to claim the event cannot depend on the launch result; it
// depends on the ONCE-PER-PAGE probe, and the host is the authority for that
// answer. When the probe says no (switch off, editor not installed, route
// missing) `apply` installs no listener and every click behaves exactly as dsh
// shipped it. When a claimed launch then fails, the failure is reported in the
// page console — the click cannot be given back, which is why the probe rather
// than the launch result is what gates interception.
//
// The surfaces, and the attribute each one anchors on:
//   - the produced-files row under a closing assistant message: a
//     `button[data-presented-file]` whose `title` IS the full path;
//   - the right sidebar's file tree: an `li[data-files-entry="file"]` whose
//     `data-files-path` is the path. Its header breadcrumb also carries a
//     `data-files-path`, which is why the entry kind is part of the selector.
//
// The tool-call result chips are deliberately NOT handled: their DOM carries a
// summary label rather than a path, so a click there cannot name its file
// without parsing prose. Deferred, not forgotten.
(() => {
  /** The routes this script calls; they must equal the host's constants. */
  const STATUS_ROUTE = "/ui-tweaks/open-in-vscode/status";
  const LAUNCH_ROUTE = "/ui-tweaks/open-in-vscode/launch";

  /** The produced-files row's file chip: its `title` is the absolute path. */
  const PRODUCED_FILE_SELECTOR = "button[data-presented-file]";

  /** The sidebar tree's file row: its `data-files-path` is the path. */
  const FILES_ENTRY_SELECTOR = 'li[data-files-entry="file"][data-files-path]';

  /** A path starting with this is a home path dsh abbreviated; the page expands it. */
  const HOME_PREFIX = "~/";

  /**
   * The file a click is aimed at, or null when the click names no file.
   *
   * Reads the DOM through the target's own `closest`, and resolves the two
   * surfaces by their attributes rather than their class names: dsh's CSS module
   * class names are per-build hashes (`o3BgMG_fileLink`), so a selector built on
   * one would break on the next dsh release, while a `data-` attribute is part
   * of the surface's tested contract.
   *
   * @param {EventTarget|null} target - the clicked node.
   * @returns {{path: string, line: number}|null} what the surface names, or null.
   */
  function fileFromClickTarget(target) {
    throw new Error("fileFromClickTarget is not implemented");
  }

  /**
   * Whether one click is the gesture this script owns: Ctrl or Cmd held and the
   * primary button. Everything else — a plain click, a middle click, a
   * shift-click — belongs to dsh. Both modifiers are honoured, so a Mac user's
   * Cmd and a Windows/Linux user's Ctrl work without configuration.
   *
   * @param {MouseEvent|object} event - a click event.
   * @returns {boolean} whether to claim it.
   */
  function isOpenInEditorGesture(event) {
    throw new Error("isOpenInEditorGesture is not implemented");
  }

  /**
   * Absolute-path resolution for a path exactly as a surface carries it: dsh
   * renders workspace paths relative to the session `cwd` and home paths as `~`.
   *
   * A path already absolute in either spelling dsh accepts (`/...`, a Windows
   * drive, a UNC prefix) is returned unchanged; a `~` path is rebuilt on the
   * host account's home when the page knows it; anything else is joined onto
   * `cwd`. With neither a home nor a `cwd` the path is returned as-is and the
   * host's existence check rejects it — a relative path is never guessed against
   * the host process's own directory.
   *
   * @param {string|undefined} cwd - the current session's workspace root.
   * @param {string} path - the path as rendered.
   * @param {string|undefined} home - the host account home, when the page knows it.
   * @returns {string} the path to send to the host.
   */
  function absolutePathFor(cwd, path, home) {
    throw new Error("absolutePathFor is not implemented");
  }

  /**
   * Ask the host whether an editor is available, and return its status payload.
   *
   * Never throws and never rejects: a non-200, a malformed body, an aborted
   * fetch, or no fetch implementation at all all mean "not available", because
   * the only consequence of a wrong no is that dsh keeps its shipped behaviour.
   *
   * @param {Function|undefined} fetchImpl - `window.fetch`.
   * @returns {Promise<{available: boolean, executable?: string, reason?: string}>}
   *   `{available: false}` on every failure; never undefined.
   */
  async function probeEditorStatus(fetchImpl) {
    throw new Error("probeEditorStatus is not implemented");
  }

  /**
   * The cordis plugin body: probe the host, then install the click listener if
   * and only if the host said yes.
   *
   * `apply` is synchronous by contract: cordis activates the plugin with it, and
   * a promise would leave the listener's installation racing the user's first
   * click. The probe is therefore fire-and-forget, and until it answers no
   * listener exists — a click that lands in that window is dsh's, exactly as
   * before.
   *
   * The listener is installed inside `ctx.effect`, so unloading the client
   * plugin removes it; the lifetime `AbortController` it owns stops an in-flight
   * launch POST when a click claimed the event a moment before the plugin went
   * away.
   *
   * @param {object} ctx - the client context; `ctx.get("sessions")` supplies the
   *   current session's `cwd`, `ctx.effect` owns the listener's life.
   * @param {Document|undefined} documentRef - the document to listen on; defaults
   *   to the page's own, and is injected by the committed check.
   */
  function apply(ctx, documentRef) {
    throw new Error("apply is not implemented");
  }

  // The exports `index.js` picks up. A classic script has no module object, so
  // the global IS the interface between the two files.
  window.__dshDotdshOpenInEditor = {
    STATUS_ROUTE,
    LAUNCH_ROUTE,
    PRODUCED_FILE_SELECTOR,
    FILES_ENTRY_SELECTOR,
    fileFromClickTarget,
    isOpenInEditorGesture,
    absolutePathFor,
    probeEditorStatus,
    apply,
  };
})();
