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
window.__ModuleLoader__.load({
  id: "@dsh-external/dotdsh-ui-tweaks",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

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
     * Ctrl/Cmd+Enter keeps sending.
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

    /**
     * Every small browser-side tweak this package owns, in install order: the
     * reason this is one generalized package rather than one package per tweak.
     * @type {readonly {id: string, description: string, install: (ctx: object) => () => void}[]}
     */
    const tweaks = [
      {
        id: "composer-enter-newline",
        description: "Bare Enter breaks the line in the composer; Ctrl/Cmd+Enter sends.",
        install: installComposerEnterNewline,
      },
    ];

    /**
     * Activate the tweak set on the browser root context. Every effect belongs to
     * this plugin's fiber, so disabling the row removes each listener again.
     * @param ctx - Client root context.
     */
    function apply(ctx) {
      ctx.effect(() => {
        const disposers = tweaks.map((tweak) => tweak.install(ctx));
        return () => {
          for (const dispose of disposers) dispose();
        };
      }, "ui-tweaks: install every tweak");
    }

    exports.apply = apply;
    return module.exports;
  },
});
