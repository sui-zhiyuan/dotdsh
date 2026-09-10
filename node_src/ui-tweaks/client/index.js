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
     * @type {{composerEnterNewline: boolean, statusWording: boolean, statusPhrases: string[]}}
     */
    const settings = {
      composerEnterNewline: true,
      statusWording: true,
      statusPhrases: [],
    };

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
