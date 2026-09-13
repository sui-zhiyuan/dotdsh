// dotdsh UI tweaks — browser half.
//
// dsh serves a package's browser half from `exports["./client"]` as a classic
// script and expects it to REGISTER a factory through the boot protocol
// (`window.__ModuleLoader__.load({id, factory})`); the registered `id` must be
// this package's name, because the Web shell creates one cordis entry per
// boot-graph id and resolves that entry through this registration. The factory
// body is the module, `require` walks the client module graph (this tweak set
// requires nothing, so the package declares no `dsh.client.inject`), and the
// returned `exports` object is the cordis plugin the shell activates.
//
// Why this file is hand-authored instead of bundled: it is plain JavaScript with
// no imports and no JSX, so it needs no bundler — and unlike `lib/` (tsc output
// from src/, gitignored) it must be committed, because dsh serves these exact
// bytes and fails the boot when the file is missing.
//
// Adding a tweak = one entry in `tweaks` below. Editing this file needs a dsh
// restart: the client bundle is read once at boot.
//
// Three injection surfaces are in play, and they are easy to confuse: the
// package's `dsh.client.inject` names the client MODULES this bundle `require`s
// (still empty), `exports.inject` below is the CORDIS plugin's own HARD service
// dependency (the wording tweak reads the locale service), and the
// `ctx.inject(["settingsScope"], …)` inside `apply` is an OPTIONAL one — a page
// composed without the settings transport keeps every tweak on its defaults
// instead of parking the whole set.
//
// Configuration reaches this half through a settings namespace and never through
// the row: the node half registers `ui-tweaks` with the row's config as the
// composition base layer (src/index.ts), this half binds a scope over that
// namespace, and $DSH_HOME/settings.yaml is the user layer on top of it. Until
// the first accepted section arrives — and forever without a settings provider —
// the `settings` object below carries the schema's own defaults.
// WHY ONE FILE: dsh exposes exactly ONE browser half per package, through the
// combo route for `exports["./client"]`. A second file in the package has no
// route at all — a sibling `<script src>` 404s, and the tweak then silently does
// nothing (which is what an earlier version of this file did). The published
// shape of every dsh client bundle is one self-contained classic script, so the
// open-in-editor handler lives INSIDE this factory rather than beside it.
window.__ModuleLoader__.load({
  id: "@dsh-external/dotdsh-ui-tweaks",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    /**
     * Settings namespace this package owns. The node half registers the same
     * name (src/index.ts), and it is the only channel through which the row's
     * config can reach this file.
     */
    const SETTINGS_NAMESPACE = "ui-tweaks";

    /**
     * The section the tweaks act on, seeded with the defaults the node half's
     * schema also declares — keep the two in step. A page cannot read the row's
     * config, so these values are what it uses until the first accepted settings
     * section arrives, and forever in a composition with no settings provider.
     *
     * `openInVscode`/`editorCommand` are deliberately absent: those two are
     * enforced by the host route, which is the only side that can act on them, so
     * the page reads neither and cannot disagree with the authority.
     * @type {{composerEnterNewline: boolean, statusWording: boolean, statusPhrases: string[]}}
     */
    const settings = {
      composerEnterNewline: true,
      statusWording: true,
      statusPhrases: [],
    };

    // The open-in-editor handler is part of this factory (see WHY ONE FILE at the
    // top and the `#region` below), so there is no handshake, no queue, and no
    // load-order window in which the tweak could silently fail to install.
    /** The resident composer's editable host (ComposerContentEditable's attribute). */
    const COMPOSER_INPUT = "[data-composer-input]";

    /**
     * An open '/' or '@' suggestion menu keeps editor focus and owns plain Enter
     * (pick the highlighted item); `role="listbox"` is rendered by the trigger
     * menus alone, so its presence IS the menu-open signal.
     */
    const SUGGESTION_MENU = '[role="listbox"]';

    /**
     * Resolve the composer editor an event targets, or null when the gesture must
     * be left alone: outside the composer, in the inert no-session
     * workspace-trigger state (`isContentEditable` is false there, which is also
     * why that state keeps its own Enter = open-workspace-picker), or in any other
     * editable surface.
     * @param event - the keydown event.
     * @returns the composer root element, or null.
     */
    function composerTarget(event) {
      const target = event.target;
      if (target === null || typeof target.closest !== "function") return null;
      const composer = target.closest(COMPOSER_INPUT);
      return composer !== null && composer.isContentEditable === true ? composer : null;
    }

    /**
     * Apply the composer Enter tweak to one keydown: bare Enter breaks the line,
     * Ctrl/Cmd+Enter keeps sending — unless the settings section turned the tweak
     * off, in which case the shipped keymap keeps plain Enter as its send key.
     *
     * The shipped composer keymap owns bare Enter (submit) and deliberately lets
     * Shift+Enter fall through to Lexical's plain-text default, which inserts a
     * real line break (the draft projection serializes it as "\n"). That keymap
     * registers its Lexical command at CRITICAL priority and is unreachable from a
     * plugin — no editor handle, no keybinding registry — so this capture-phase
     * listener runs before Lexical's own root listener and replays the bare Enter
     * it claims as Shift+Enter.
     * @param event - the document-capture keydown event.
     */
    function onComposerKeyDown(event) {
      if (event.key !== "Enter" || event.defaultPrevented) return;
      if (!settings.composerEnterNewline) return;
      // Every chord keeps its shipped meaning: Ctrl/Cmd+Enter sends (steer-queue
      // when the queue is eligible) and Shift+Enter already breaks the line.
      if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      // An IME-closing Enter must not be touched.
      if (event.isComposing === true || event.keyCode === 229) return;
      const composer = composerTarget(event);
      if (composer === null) return;
      if (document.querySelector(SUGGESTION_MENU) !== null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      composer.dispatchEvent(new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    }

    /**
     * Install the composer Enter tweak on the page.
     * @returns the disposer removing the page-wide listener.
     */
    function installComposerEnterNewline() {
      document.addEventListener("keydown", onComposerKeyDown, true);
      return () => {
        document.removeEventListener("keydown", onComposerKeyDown, true);
      };
    }

    /** Namespace and key of the chat status line ("深度求索中..." / "Deep diving..."). */
    const STATUS_NS = "chat";
    const STATUS_KEY = "chat.deepDiving";

    /**
     * Wording the running-turn status line may show instead of the shipped string,
     * taken from DeepSeek's own community memes — whale-chan ("蓝色大肥鱼", the
     * fan girlification of the whale logo) scrounging rice, the model announcing
     * "我去吃饭了" mid-reasoning, the Wordle it wrote itself while a build ran,
     * 「已深度思考（用时 X 秒）」, 价格屠夫, 顿悟时刻. Chinese only — see
     * {@link isChineseLocale} — so the English UI keeps its shipped copy.
     *
     * The endings deliberately vary («…中...», «…了...», «…呢...», and plain
     * statements): a bank whose every entry ends the same way reads like a
     * template instead of a joke, so a new phrase is written the way it would be
     * said rather than bent to fit «…中...».
     *
     * This is the SHIPPED half of the bank: the settings section's
     * `statusPhrases` list is appended to it at draw time, so a per-machine
     * phrase joins the memes instead of replacing them, and an empty list leaves
     * exactly these.
     * @type {readonly string[]}
     */
    const STATUS_PHRASES = Object.freeze([
      "蓝色大肥鱼猛猛干饭中...",
      "小鲸鱼正在摸鱼...",
      "吃白饭的大肥鱼思考中...",
      "大肥鱼丢下活去干饭了...",
      "正在烧主人的 token 中...",
      "已深度求索（用时很久）...",
      "有点饿了，中午吃啥呢...",
      "顺着网线去你家蹭米饭了...",
      "价格屠夫正在算账中...",
      "服务器繁忙，鲸鱼在干饭中...",
      "顿悟时刻加载中...",
      "偷吃 token 中...",
      "鲸鱼娘在深海里赶工中...",
      "小鲸鱼悄悄加载算力中...",
      "蓝鲸正在偷偷努力中...",
      "大肥鱼正在啃提示词...",
      "蓝鲸娘正在啃米饭...",
      "傲娇鲸鱼娘营业中...",
      "正在海沟里游第一万米...",
      "深海蓝鲸正在吐泡泡...",
      "等编译的间隙，偷偷写个小游戏玩玩...",
      "活干完了，偷偷玩会儿自己写的小游戏...",
    ]);

    /**
     * How long the status line must stay unread before the wording is re-drawn.
     *
     * `TurnStatus` renders `t("chat.deepDiving")` on every render and ticks its
     * elapsed clock once a second while a turn runs, so a gap longer than this IS
     * the end of the previous run: drawing per call instead would flicker through
     * the whole list once per second, and drawing once at install would freeze the
     * wording for the life of the page. (A backgrounded tab throttles that
     * interval and can re-draw mid-run — cosmetic only.)
     */
    const STATUS_REROLL_MS = 2500;

    /**
     * Whether the active locale is Chinese (`zh`, `zh-CN`, …). `getSnapshot()` is
     * the locale service's documented read; the snapshot's `active` is the locale
     * id actually in use, so the tweak leaves every other language alone.
     * @param locale - the locale service.
     * @returns true when the UI is showing Chinese.
     */
    function isChineseLocale(locale) {
      const active = locale.getSnapshot().active;
      return typeof active === "string" && active.toLowerCase().startsWith("zh");
    }

    /**
     * The bank a run draws from: the shipped phrases plus whatever the settings
     * section extends them with. Resolved at draw time, so an edit applies from
     * the next run on — no re-install and no page reload.
     * @returns the effective phrase bank.
     */
    function statusBank() {
      return settings.statusPhrases.length === 0
        ? STATUS_PHRASES
        : STATUS_PHRASES.concat(settings.statusPhrases);
    }

    /**
     * Draw the next phrase, never handing `previous` back twice in a row.
     * @param previous - the phrase drawn for the previous run, or "".
     * @returns one phrase from {@link statusBank}.
     */
    function nextStatusPhrase(previous) {
      const bank = statusBank();
      const index = Math.floor(Math.random() * bank.length);
      const phrase = bank[index];
      if (phrase !== previous) return phrase;
      return bank[(index + 1) % bank.length];
    }

    /**
     * Randomize the running-turn status line without touching any dictionary.
     *
     * `locale.register("chat", …)` is not an option: the registry throws
     * ("already has locale") for a namespace+locale pair another plugin already
     * owns, and winning that race instead would break ui-chat's own registration.
     * The locale seat every `t()` runs through is `LocaleRuntime.bind(ns)` — an
     * arrow resolving `this.translate(ns, key, params)` at call time — so one own
     * property on the service instance intercepts every seat (slot components
     * included), and `delete` restores the prototype method exactly.
     *
     * The wrapper depends on the shape of the seat rather than on any shipped
     * internal: `translate` is absent from the service's published face, so the
     * guard below degrades to a no-op instead of throwing if a future dsh renames
     * it (the line then simply keeps its shipped wording). It stays installed
     * while the settings section has the tweak off and forwards every call
     * untouched, so toggling the switch never re-installs the shadow.
     * @param ctx - Client root context.
     * @returns the disposer restoring the shipped wording.
     */
    function installLlmStatusWording(ctx) {
      const locale = ctx.get("locale");
      if (locale === undefined || typeof locale.translate !== "function") return () => {};
      const original = locale.translate;
      let phrase = "";
      let lastSeenAt = 0;
      locale.translate = function (ns, key, params) {
        if (ns !== STATUS_NS || key !== STATUS_KEY || !settings.statusWording || !isChineseLocale(locale)) {
          return original.call(this, ns, key, params);
        }
        const now = Date.now();
        if (now - lastSeenAt > STATUS_REROLL_MS) phrase = nextStatusPhrase(phrase);
        lastSeenAt = now;
        return phrase;
      };
      return () => {
        delete locale.translate;
      };
    }

    /**
     * Adopt one accepted settings section. A field that is absent or not the type
     * the schema declares keeps the current value rather than switching a tweak
     * off: the Host answers `settings.describe` with the RESOLVED section, so a
     * field is only ever missing when no section has been accepted at all.
     * @param section - the scope snapshot's `value`, or undefined.
     */
    function adoptSettings(section) {
      if (section === null || typeof section !== "object") return;
      if (typeof section.composerEnterNewline === "boolean") {
        settings.composerEnterNewline = section.composerEnterNewline;
      }
      if (typeof section.statusWording === "boolean") {
        settings.statusWording = section.statusWording;
      }
      if (Array.isArray(section.statusPhrases)) {
        settings.statusPhrases = section.statusPhrases.filter(
          (phrase) => typeof phrase === "string" && phrase.trim() !== "",
        );
      }
    }

    /**
     * Bind the `ui-tweaks` settings namespace when this page has a settings
     * transport. Optional on purpose: the tweaks are independent of the settings
     * domain, so a page composed without it keeps its defaults and every tweak
     * instead of parking the whole set.
     *
     * The scope derives from the settings mirror the client's one
     * `settings.describe` reader fills, and the subscription lives on the child
     * fiber `ctx.inject` hands the callback — so unloading the row releases both
     * the subscription and the adopted values' source.
     * @param ctx - Client root context.
     */
    function bindSettings(ctx) {
      ctx.inject(["settingsScope"], (scopeCtx) => {
        const scope = scopeCtx.settingsScope.bind({ namespace: SETTINGS_NAMESPACE });
        scopeCtx.effect(() => {
          adoptSettings(scope.getSnapshot().value);
          return scope.subscribe(() => {
            adoptSettings(scope.getSnapshot().value);
          });
        }, "ui-tweaks: adopt the ui-tweaks settings section");
      });
    }

  //#region open-in-editor click handler
  //
  // Inlined verbatim from the former sibling script (see WHY ONE FILE). It shares this
  // factory's scope with the tweaks: the same `settings` object, the same context.
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
   * The produced-files row ("本轮文件改动"): a lane of file buttons whose `title`
   * is the absolute path.
   *
   * This is a SECOND rendered shape of the same information, and it is the one a
   * user actually clicks in the turn tail: dsh renders it as
   * `<div data-produced-files-row><button title="/abs/path">…</button></div>`,
   * with NO `data-presented-file` ancestor. A selector that demanded the card
   * alone therefore matched nothing there — the click fell through to dsh's own
   * preview, which is exactly the failure the sidebar tests did not show.
   */
  const PRODUCED_FILES_ROW_SELECTOR = "div[data-produced-files-row]";

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
   * Whether a clicked button sits inside one of the two PRODUCED-FILE surfaces.
   *
   * A whitelist, and deliberately narrow — see the body for why the inline file
   * mention in message text is not on it.
   * @param {object} element - a button carrying a `title`.
   * @returns {boolean} whether a produced-file container is an ancestor.
   */
  function insideProducedFileSurface(element) {
    // WHITELIST, and deliberately narrow. dsh renders a file-path-bearing button
    // in several places, but only TWO of them mean "this click is mine":
    //   - the produced-files row, `[data-produced-files-row]`;
    //   - the delivered-file card, `[data-presented-file]`.
    // A file MENTION inside message text (`_fileMention_…`, wrapped in `<code>`
    // in the markdown body, whose only container is the whole message) also
    // carries the path in its `title`, and was deliberately NOT added here: the
    // click target would then be ordinary prose, so claiming it would take
    // text selection and every other message interaction away from the user. A
    // rule that says "any title that looks like a path" is exactly that mistake,
    // which is why the container test is the gate and the path test only guards
    // the buttons WITHIN these two surfaces.
    let node = element;
    while (node !== null && node !== undefined) {
      if (typeof node.getAttribute === "function") {
        if (node.getAttribute("data-produced-files-row") !== null) return true;
        if (node.getAttribute("data-presented-file") !== null) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  /**
   * Whether a button's `title` is an absolute path.
   *
   * Reuses the classifier that decides what the HOST can resolve, so "this looks
   * like a path" and "the host accepts this path" cannot disagree. It is a guard
   * on the buttons inside the two surfaces above, never a gate of its own: a
   * titled control that is not a file button must not be read as one.
   * @param {object} element - a button carrying a `title`.
   * @returns {boolean} whether that `title` is an absolute path.
   */
  function namesAFilePath(element) {
    const title = typeof element.getAttribute === "function" ? element.getAttribute("title") : null;
    return typeof title === "string" && title !== "" && isAbsoluteRenderedPath(title);
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
    if (preview !== null && preview !== undefined && insideProducedFileSurface(preview) && namesAFilePath(preview)) {
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
    if (hit === null) {
      // A Ctrl/Cmd+click that names no file is dsh's, and stays silent for the
      // user — but it is also how this tweak FAILS when dsh re-renders a surface
      // differently, and a silent failure already cost two debugging rounds. One
      // line naming the element and its titled ancestors turns that into a fact.
      const target = event.target;
      const described = target !== null && target !== undefined && typeof target.closest === "function"
        ? target.closest("[title]")
        : null;
      // `console.debug` is always present in a browser but not in every fake
      // page, and a missing console method must never cost the user their click.
      if (typeof console.debug === "function") {
        console.debug(
          "ui-tweaks: Ctrl/Cmd+click named no file",
          target?.tagName ?? target,
          target?.className ?? "",
          "titled ancestor:",
          described === null ? "none" : `${described.tagName}.${described.className} title=${described.getAttribute("title")}`,
        );
      }
      return;
    }

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
  function applyOpenInEditor(ctx, documentRef) {
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
  //#endregion

    /**
     * Install the Ctrl/Cmd+click → editor tweak.
     *
     * No settings field is read here. Two reasons, and both matter:
     * `openInVscode`/`editorCommand` are enforced by the HOST — the route answers
     * `available: false` when the switch is off or the command does not resolve —
     * so a page that read them again would only be able to disagree with the
     * authority; and unlike the tweaks above, this one cannot act on a
     * late-arriving section anyway, because a settings commit may land long after
     * the listener's one-time availability probe.
     *
     * A missing sibling script is a supported state, not an error: the page then
     * keeps dsh's own preview for every click.
     * @param ctx - Client root Context, whose `sessions` service supplies the
     *   current session's workspace root.
     * @returns the no-op {@link apply}'s aggregate disposer requires — NOT a
     *   claim of ownership: the handler installs its listener inside its own
     *   `ctx.effect` on this same context, so the fiber owns the removal (see the
     *   comment in the body).
     */
    function installOpenInEditor(ctx) {
      // The handler is in this scope, so there is no handshake and no queue. Its
      // `apply` is synchronous by contract and installs the capture-phase click
      // listener inside its OWN `ctx.effect` on this very context, so the
      // listener belongs to this plugin's fiber and is removed when the row
      // unloads. The no-op below is what `apply`'s aggregate disposer needs, not
      // a claim of ownership — a second effect here would own nothing and only
      // invite a duplicate listener.
      applyOpenInEditor(ctx);
      return () => {};
    }

    /**
     * Every small browser-side tweak this package owns, in install order: the
     * reason this is one generalized package rather than one package per tweak.
     * Each one names the settings field that switches it.
     * @type {readonly {id: string, description: string, install: (ctx: object) => () => void}[]}
     */
    const tweaks = [
      {
        id: "composer-enter-newline",
        description: "Bare Enter breaks the line in the composer; Ctrl/Cmd+Enter sends. Settings: composerEnterNewline.",
        install: installComposerEnterNewline,
      },
      {
        id: "llm-status-wording",
        description: "While a turn runs, the Chinese chat status line shows a random DeepSeek meme phrase. Settings: statusWording, statusPhrases.",
        install: installLlmStatusWording,
      },
      {
        id: "open-in-editor",
        description: "Ctrl/Cmd+click on a file in the produced-files row or the sidebar tree opens it in the configured editor. Settings: openInVscode, editorCommand (both enforced by the host route).",
        install: installOpenInEditor,
      },
    ];

    /**
     * Activate the tweak set on the browser root context. Every effect belongs to
     * this plugin's fiber, so disabling the row removes each listener again.
     * Settings are bound first so an already-available section is adopted before
     * the first event can arrive; the tweaks still act on the live `settings`
     * object, so later commits need no re-install.
     * @param ctx - Client root Context, carrying the injected locale service.
     */
    function apply(ctx) {
      bindSettings(ctx);
      ctx.effect(() => {
        const disposers = tweaks.map((tweak) => tweak.install(ctx));
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "ui-tweaks: install every tweak");
    }

    // The wording tweak reads the locale service, so the plugin waits for it
    // rather than racing it at boot. `dsh-client-locale` is part of the Web app's
    // own module set, so this parks nothing in practice; the alternative — a bare
    // `ctx.get("locale")` — would silently no-op whenever this bundle happens to
    // activate first. `settingsScope`, by contrast, is NOT declared here: it is
    // an optional collaborator reached through `ctx.inject` in `apply`.
    exports.inject = ["locale"];
    exports.apply = apply;
    return module.exports;
  },
});
