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
//   - the produced-files row under a closing assistant message: the
//     `div[data-presented-file]` card, whose descendant preview `button` carries
//     the absolute path as its `title`;
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

  /**
   * The produced-files row's file card: the container the attribute sits on.
   *
   * The attribute is on the CARD, not on the button that carries the path — a
   * fact this file originally got wrong (it looked for `button[data-presented-file]`
   * and could never match), which is why the two selectors are separate.
   */
  const PRODUCED_FILE_SELECTOR = "div[data-presented-file]";

  /**
   * Inside the card, the button whose `title` is the path.
   *
   * dsh renders the card as an absolutely positioned overlay button whose `title`
   * is `resolveWorkspacePath(cwd, file.path)` — an ABSOLUTE path — beside a split
   * button and a menu that address the same card. Matching on the attribute
   * rather than the hashed class name (`…cardPreview`) keeps this working across
   * dsh builds, and requiring a BUTTON keeps a click on the split button or a
   * menu item out of this tweak.
   */
  const PRODUCED_FILE_PATH_SELECTOR = "button[title]";

  /** The sidebar tree's file row: its `data-files-path` is the path. */
  const FILES_ENTRY_SELECTOR = 'li[data-files-entry="file"][data-files-path]';

  /** A path starting with this is a home path dsh abbreviated; the page expands it. */
  const HOME_PREFIX = "~/";

  /**
   * Whether a rendered path is already absolute in a spelling the host accepts.
   *
   * Mirrors the client's own classifier rather than inventing one: dsh accepts a
   * POSIX `/a/b`, a Windows drive (`C:\a` / `C:/a`), and a `\\server\share` UNC
   * prefix, and each of those must be sent on untouched because it already names
   * a location the host's existence check can resolve.
   * @param {string} path - the path as a surface rendered it.
   * @returns {boolean} whether it is absolute.
   */
  function isAbsoluteRenderedPath(path) {
    if (path.startsWith("/")) return true;
    if (path.startsWith("\\\\")) return true;
    return /^[A-Za-z]:[/\\]/.test(path);
  }

  /**
   * Join two path fragments with exactly one separator.
   *
   * The separator is taken from the BASE's own spelling, because the host is the
   * side that has to recognize the result: a Windows account home or session cwd
   * arrives backslash-separated while the surfaces render their relative halves
   * with `/`, and the client's own `resolveWorkspacePath` chooses exactly this
   * way. A base that is nothing but a root (`/` or `C:\`) keeps its one
   * separator instead of gaining a second. The tree's POSIX join passes its
   * separator explicitly, because a workspace-relative entry is always rendered
   * with `/` regardless of the root's spelling.
   * @param {string} base - the absolute prefix.
   * @param {string} rest - the relative remainder.
   * @param {string} [separator] - the joiner; derived from `base` when omitted.
   * @returns {string} the joined path.
   */
  function joinPathFragments(base, rest, separator) {
    let head = base;
    while (head.length > 1 && (head.endsWith("/") || head.endsWith("\\"))) {
      head = head.slice(0, -1);
    }
    let tail = rest;
    while (tail.startsWith("/") || tail.startsWith("\\")) {
      tail = tail.slice(1);
    }
    if (tail === "") return head;
    const join = separator === undefined ? (head.includes("\\") ? "\\" : "/") : separator;
    if (head.endsWith(join)) return head + tail;
    return head + join + tail;
  }

  /**
   * The workspace root the sidebar tree hangs under, from the nearest ancestor
   * carrying `data-files-root`.
   *
   * The attribute sits on a wrapper above the `li`, so the row cannot read it
   * from itself; walking parent elements keeps this a read of the tree's own
   * markup rather than a guess about which wrapper element dsh used. An absent
   * root is not an error: the caller then hands the host the relative path it
   * was given, and the host's own existence check rejects it.
   * @param {object} element - the matched tree row.
   * @returns {string|null} the root as rendered, or null.
   */
  function ancestorDataFilesRoot(element) {
    let node = element.parentElement;
    while (node !== null && node !== undefined) {
      if (typeof node.getAttribute === "function") {
        const root = node.getAttribute("data-files-root");
        if (typeof root === "string" && root !== "") return root;
      }
      node = node.parentElement;
    }
    return null;
  }

  /**
   * Whether an element sits inside a produced-files card.
   *
   * A manual ancestor walk rather than `element.closest`, for the same reason
   * {@link ancestorDataFilesRoot} walks: the caller already used `closest` once,
   * and this second question is about containment, which a `closest` on a
   * different selector cannot answer.
   * @param {object} element - an element known to carry a `title`.
   * @returns {boolean} whether a `[data-presented-file]` ancestor exists.
   */
  function insideProducedFileCard(element) {
    let node = element;
    while (node !== null && node !== undefined) {
      if (typeof node.getAttribute === "function" && node.getAttribute("data-presented-file") !== null) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

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
   * @returns {{path: string, line?: number}|null} what the surface names, or null.
   *   `line` is absent on both surfaces this script handles today; it stays in the
   *   shape because the wire payload accepts one and a future surface may name it.
   */
  function fileFromClickTarget(target) {
    // A non-element (the document, a text node, `window`) has no `closest`, and
    // is therefore a click that names no file.
    if (target === null || target === undefined || typeof target.closest !== "function") {
      return null;
    }

    // The clicked BUTTON must be the one inside a card: matching the card first
    // and then searching inside it would attribute the card's split button and
    // menu items to that same path, which is why the order is button-then-card.
    // The card check is a manual ancestor walk rather than `closest`, because the
    // button may not be a DOM *descendant* of the card in a fake document while
    // still being one in the page.
    const preview = target.closest(PRODUCED_FILE_PATH_SELECTOR);
    if (preview !== null && preview !== undefined && insideProducedFileCard(preview)) {
      const title = typeof preview.getAttribute === "function"
        ? preview.getAttribute("title")
        : null;
      // The attribute names the file; a card without one names nothing, so the
      // click is left to dsh rather than guessed at.
      if (typeof title !== "string" || title === "") return null;
      return { path: title };
    }

    const entry = target.closest(FILES_ENTRY_SELECTOR);
    if (entry !== null && entry !== undefined) {
      const rendered = typeof entry.getAttribute === "function"
        ? entry.getAttribute("data-files-path")
        : null;
      if (typeof rendered !== "string" || rendered === "") return null;
      if (isAbsoluteRenderedPath(rendered)) return { path: rendered };
      const root = ancestorDataFilesRoot(entry);
      // No root ancestor means the tree did not render one; the relative path is
      // still the surface's answer, and the host gets to reject it.
      if (root === null) return { path: rendered };
      return { path: joinPathFragments(root, rendered, "/") };
    }

    return null;
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
    if (event === null || event === undefined) return false;
    if (event.button !== 0) return false;
    return event.ctrlKey === true || event.metaKey === true;
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
    if (typeof path !== "string") return path;
    if (isAbsoluteRenderedPath(path)) return path;
    const knownHome = typeof home === "string" && home !== "" ? home : undefined;
    if (path === "~") return knownHome === undefined ? path : knownHome;
    if (path.startsWith(HOME_PREFIX)) {
      // Without a home the abbreviated path stays abbreviated: expanding it
      // against anything else would name a directory the user did not click.
      if (knownHome === undefined) return path;
      return joinPathFragments(knownHome, path.slice(HOME_PREFIX.length));
    }
    if (typeof cwd !== "string" || cwd === "") return path;
    return joinPathFragments(cwd, path);
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
    if (typeof fetchImpl !== "function") return { available: false };

    let response;
    try {
      response = await fetchImpl(STATUS_ROUTE, {
        method: "GET",
        credentials: "same-origin",
      });
    } catch (error) {
      return { available: false };
    }
    if (response === null || response === undefined || response.ok !== true) {
      return { available: false };
    }

    let payload;
    try {
      if (typeof response.json !== "function") return { available: false };
      payload = await response.json();
    } catch (error) {
      return { available: false };
    }
    // An array is not the status object either, however object-like `typeof` says
    // it is, and `available` must be the boolean `true` — a truthy stand-in is a
    // body this script did not agree with, so the safe answer is "no".
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return { available: false };
    }
    if (payload.available !== true) return { available: false };

    const status = { available: true };
    // Diagnostics only, and only in the type the wire declares: a body that
    // carried something else must not put it on the status object.
    if (typeof payload.executable === "string") status.executable = payload.executable;
    if (typeof payload.reason === "string") status.reason = payload.reason;
    return status;
  }

  /**
   * Read one cordis service without letting a composition that lacks it turn a
   * click into an exception. `ctx.get` is the documented accessor; a fake context
   * in a test may not implement it at all.
   * @param {object} ctx - the client context.
   * @param {string} name - the service name.
   * @returns {object|null} the service, or null.
   */
  function clientService(ctx, name) {
    if (ctx === null || ctx === undefined || typeof ctx.get !== "function") return null;
    let service;
    try {
      service = ctx.get(name);
    } catch (error) {
      return null;
    }
    return service === null || service === undefined ? null : service;
  }

  /**
   * The current session id and its workspace root, read from the sessions store's
   * snapshot.
   *
   * Every step is allowed to be absent — the service, the store, the selection,
   * the summary, or the summary's `cwd` — and each absence degrades to
   * `undefined` rather than throwing, because a click that lands while the page
   * and the store disagree must still be handled. The caller turns a missing
   * `cwd` into "send the path as rendered and let the host reject it", and a
   * missing `sessionId` into a launch the host answers with a request error.
   * @param {object} ctx - the client context.
   * @returns {{sessionId: string|undefined, cwd: string|undefined}} what the store held.
   */
  function currentSessionFacts(ctx) {
    const facts = { sessionId: undefined, cwd: undefined };
    const sessions = clientService(ctx, "sessions");
    if (sessions === null || sessions.list === null || sessions.list === undefined) return facts;
    if (typeof sessions.list.getSnapshot !== "function") return facts;

    let snapshot;
    try {
      snapshot = sessions.list.getSnapshot();
    } catch (error) {
      return facts;
    }
    if (snapshot === null || snapshot === undefined || typeof snapshot !== "object") return facts;
    if (typeof snapshot.current === "string" && snapshot.current !== "") {
      facts.sessionId = snapshot.current;
    }
    const byId = snapshot.byId;
    if (facts.sessionId === undefined || byId === null || byId === undefined) return facts;
    if (typeof byId !== "object") return facts;
    const summary = byId[facts.sessionId];
    if (summary === null || summary === undefined || typeof summary !== "object") return facts;
    if (typeof summary.cwd === "string" && summary.cwd !== "") facts.cwd = summary.cwd;
    return facts;
  }

  /**
   * The host account home, when the page exposes one.
   *
   * Read defensively and never depended on: dsh's own client carries host facts
   * as an observable (`getSnapshot().home`), a plain `home` member is accepted
   * too, and anything else — a service that does not exist, a snapshot that
   * throws, a non-string home — simply leaves `~` unexpanded, which the host
   * then rejects rather than this script throwing inside a click.
   * @param {object} ctx - the client context.
   * @returns {string|undefined} the host home, or undefined.
   */
  function hostHome(ctx) {
    const info = clientService(ctx, "hostInfo");
    if (info === null) return undefined;
    let facts = info;
    if (typeof info.getSnapshot === "function") {
      try {
        facts = info.getSnapshot();
      } catch (error) {
        return undefined;
      }
    }
    if (facts === null || facts === undefined || typeof facts !== "object") return undefined;
    return typeof facts.home === "string" && facts.home !== "" ? facts.home : undefined;
  }

  /**
   * POST one launch and report the single failure line the page console gets.
   *
   * The click has already been claimed by the time this runs, so a failure here
   * can only be reported, never undone, and the report is exactly one line: a
   * claimed click that failed is a curiosity in the console, not a state the page
   * can return to.
   * @param {Function|undefined} fetchImpl - `window.fetch`.
   * @param {object} body - the launch request body.
   * @param {AbortSignal|undefined} signal - the plugin lifetime's signal.
   */
  function launchEditor(fetchImpl, body, signal) {
    if (typeof fetchImpl !== "function") {
      console.error("ui-tweaks: open-in-editor launch skipped (no fetch)");
      return;
    }
    const init = {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    };
    if (signal !== undefined) init.signal = signal;

    let pending;
    try {
      pending = fetchImpl(LAUNCH_ROUTE, init);
    } catch (error) {
      console.error("ui-tweaks: open-in-editor launch request failed", error);
      return;
    }
    if (pending === null || pending === undefined || typeof pending.then !== "function") {
      console.error("ui-tweaks: open-in-editor launch request failed (no response)");
      return;
    }
    pending.then(
      (response) => {
        if (response !== null && response !== undefined && response.ok === true) return;
        const status = response !== null && response !== undefined ? response.status : "unknown";
        console.error("ui-tweaks: open-in-editor launch failed", status);
      },
      (error) => {
        // An abort is this script's own disposal, not a host failure, so it must
        // not print the failure line the user would read as "the editor broke".
        if (signal !== undefined && signal.aborted === true) return;
        console.error("ui-tweaks: open-in-editor launch request failed", error);
      },
    );
  }

  /**
   * One capturing document click, reduced to the decision this script owns.
   *
   * Everything before the POST is synchronous and cannot consult the response,
   * and the event is claimed the moment the target is known to name a file — a
   * `stopPropagation()` would still let React's delegated root listener, which
   * is on an ancestor in the same dispatch, see and act on the click.
   * @param {object} ctx - the client context.
   * @param {MouseEvent} event - the click event.
   * @param {Function|undefined} fetchImpl - `window.fetch`.
   * @param {AbortSignal|undefined} signal - the plugin lifetime's signal.
   */
  function onOpenInEditorClick(ctx, event, fetchImpl, signal) {
    if (!isOpenInEditorGesture(event)) return;
    const hit = fileFromClickTarget(event.target);
    if (hit === null) return;

    // Claim before any further work, and independently of it: the launch result
    // arrives after dispatch has finished, so nothing later can hand the click
    // back to dsh's preview.
    event.preventDefault();
    event.stopImmediatePropagation();

    const session = currentSessionFacts(ctx);
    const body = {
      sessionId: session.sessionId,
      path: absolutePathFor(session.cwd, hit.path, hostHome(ctx)),
    };
    // The optional line travels only when a surface knew one; the two wired
    // surfaces do not, and `undefined` would be dropped by the serializer anyway.
    if (hit.line !== undefined) body.line = hit.line;
    launchEditor(fetchImpl, body, signal);
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
    const doc = documentRef !== undefined && documentRef !== null
      ? documentRef
      : window.document;
    if (doc === null || doc === undefined || typeof doc.addEventListener !== "function") return;
    // Without `ctx.effect` there is no owner for the listener's lifetime, and an
    // unremovable listener is worse than no interception: the fake DOM in a test
    // therefore gets the shipped behaviour, not a throw at boot.
    if (ctx === null || ctx === undefined || typeof ctx.effect !== "function") return;

    const fetchImpl = typeof window.fetch === "function" ? window.fetch : undefined;

    ctx.effect(() => {
      // A browser always has AbortController; a fake page may not, and aborting
      // is an optimization on top of removing the listener, so its absence must
      // not cost the whole tweak.
      const controller = typeof AbortController === "function" ? new AbortController() : null;
      const signal = controller === null ? undefined : controller.signal;
      let listener = null;
      let disposed = false;

      // Fire and forget: `apply` cannot await this, and the probe's only effect is
      // whether a listener ever gets installed.
      probeEditorStatus(fetchImpl).then((status) => {
        // The probe may answer after the plugin was unloaded; installing then
        // would leave a listener nothing can remove.
        if (disposed || status === null || status === undefined || status.available !== true) return;
        listener = (event) => onOpenInEditorClick(ctx, event, fetchImpl, signal);
        doc.addEventListener("click", listener, true);
      });

      return () => {
        disposed = true;
        if (listener !== null) doc.removeEventListener("click", listener, true);
        if (controller !== null) controller.abort();
      };
    }, "ui-tweaks: intercept Ctrl/Cmd+click to open a file in the editor");
  }

  // The exports `index.js` picks up. A classic script has no module object, so
  // the global IS the interface between the two files. `index.js` may have run
  // its factory before or after this file executed (an injected script loads
  // asynchronously), so the export is announced through its ready hook when it
  // installed one, and left on the global as well for a reader that arrives
  // later or for a page that never installed the hook.
  const exports_ = {
    STATUS_ROUTE,
    LAUNCH_ROUTE,
    PRODUCED_FILE_SELECTOR,
    PRODUCED_FILE_PATH_SELECTOR,
    FILES_ENTRY_SELECTOR,
    fileFromClickTarget,
    isOpenInEditorGesture,
    absolutePathFor,
    probeEditorStatus,
    apply,
  };
  window.__dshDotdshOpenInEditor = exports_;
  if (typeof window.__dshDotdshOpenInEditorReady === "function") {
    window.__dshDotdshOpenInEditorReady(exports_);
  }
})();
