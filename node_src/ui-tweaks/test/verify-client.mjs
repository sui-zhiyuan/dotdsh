// The committed check for the ui-tweaks browser half. Run: pnpm test
//
// `client/index.js` is the one source file in this repository with no compiler
// behind it: `tsc` only builds `src/`, and dsh serves this exact file to the
// page, failing the boot when it is missing. This script is its gate.
//
// ONE SCRIPT, ONE SANDBOX, ONE WINDOW. dsh exposes exactly one browser route for
// a package — the combo route for `exports["./client"]` — so the committed
// browser half is necessarily one self-contained classic script, and every
// behaviour it ships must be reachable through that one registration. This
// check therefore runs `client/index.js` once in a single `node:vm` context
// whose fake `window` captures `__ModuleLoader__.load`, calls the captured
// `factory(require)` for the module exports, and then drives those exports' own
// `apply(ctx)` with a fake client context (one fake `document`; a fake
// `sessions`, `hostInfo` and settings scope; a fake `window.fetch`) and asserts
// the three tweaks' decisions through the listeners that activation installs.
// Because there is only one route, no second file is loaded anywhere: the
// open-in-editor handler is proved reachable only through the module's own
// activation on that same document. `node --check` and this file together are
// what guard these bytes.
//
// What a green run does NOT mean: there is no real dsh, no browser, no React, no
// Lexical, no locale service, no settings transport, no network and no editor.
// The registration checks prove the boot protocol's shape, not that dsh resolved
// `exports["./client"]`, served this file or added it to the boot graph with a
// `rev`. The Enter checks assert the shape of the synthetic event the tweak
// re-emits, not that Lexical inserted a line break; the wording checks assert
// what the locale wrapper returns, not that the page re-rendered the new text;
// the settings checks publish a section into the fake scope directly, so they
// prove what the page does with one, not that dsh resolved, delivered or
// persisted it (that seam is the host half's own check, test/verify-host.mjs).
// The open-in-editor checks dispatch hand-built click events at hand-built
// element objects, so they prove which attributes and gestures the handler
// selects, what it posts and that it claims the event, not that a real DOM
// produced those elements, that the host route answered, or that an editor
// opened. Whether any tweak works end to end is settled by loading the page once.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The file sits in the package it verifies (test/ one level below the manifest),
// so its package directory comes from its own location: no repo-root guess, and
// nothing breaks if the file moves with the package.
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

//#region manifest contract (mirrors @deepseek-ai/dsh-client-modules parseDshClient/clientExportOf)
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const decl = pkg.dsh?.client;
check("dsh.client is an object", typeof decl === "object" && decl !== null);
check("dsh.client.platform === 'web'", decl?.platform === "web", String(decl?.platform));
check(
  "dsh.client.inject/external are string arrays or absent",
  [decl?.inject, decl?.external].every(
    (v) => v === undefined || (Array.isArray(v) && v.every((s) => typeof s === "string")),
  ),
);
const clientField = pkg.exports?.["./client"];
const clientRel =
  typeof clientField === "string" ? clientField : clientField?.default;
check("exports['./client'] is a string or {default}", typeof clientRel === "string");
const clientPath = join(pkgDir, clientRel);
check("client bundle file exists", existsSync(clientPath), clientPath);
check(
  "the client bundle ships in package.files",
  (pkg.files ?? []).includes(String(clientRel).replace(/^\.\//, "")),
  String(pkg.files),
);
// dsh resolves exactly this one subpath to exactly one file and serves no other
// file in the package. A second file under client/ therefore has no route at
// all: a sibling `<script src>` 404s and whatever it carried silently never
// runs. The committed browser half must stay one self-contained script.
const clientFiles = readdirSync(join(pkgDir, "client")).sort();
check(
  "the client entry is the package's only browser file (one route, one script)",
  clientFiles.length === 1 && clientFiles[0] === basename(clientRel),
  clientFiles.join(", "),
);
const bundle = readFileSync(clientPath, "utf8");
//#endregion

//#region one sandbox: the fake page `client/index.js` runs against
// The wording tweak draws from the page realm's Math/Date: pin both so its
// re-draw rule (not the dice) is what the checks below assert.
let fakeNow = 1_000_000;
const randoms = [];

const makeDocument = () => {
  const documentListeners = [];
  return {
    listeners: documentListeners,
    // The suggestion menu belongs to the composer tweak; `menuOpen` is flipped
    // by its region below, exactly as a rendered listbox would appear.
    querySelector: () => (menuOpen ? { marker: "listbox" } : null),
    addEventListener(type, fn, capture) {
      documentListeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn, capture) {
      const index = documentListeners.findIndex(
        (entry) => entry.type === type && entry.fn === fn && entry.capture === capture,
      );
      if (index >= 0) documentListeners.splice(index, 1);
    },
  };
};
let menuOpen = false;

// Every fetch the page makes goes through here, so one recording fake serves
// both the availability probe and the launch POST. `probeImpl` and
// `launchAnswer` are the knobs the scenarios below turn.
const fetchCalls = [];
let probeImpl = () =>
  Promise.resolve({ ok: true, json: async () => ({ available: true }) });
let launchAnswer = () => Promise.resolve({ ok: true, status: 200 });
const fakeFetch = (url, init = {}) => {
  const method = init.method ?? "GET";
  fetchCalls.push({ url, method, init });
  if (method === "GET") return probeImpl(url, init);
  return launchAnswer(url, init);
};

const consoleErrors = [];
const abortControllers = [];

// The document the module listens on. `sandbox.document` is the classic-script
// page global the composer tweak reads; `window.document` is what the
// open-in-editor handler reads. They are the SAME object, and both listeners
// must land in its one `listeners` array — that single array is the property
// this check exists to prove.
const documentRef = makeDocument();
let registration;
const sandbox = {
  window: {
    __ModuleLoader__: {
      load: (reg) => {
        registration = reg;
      },
    },
    document: documentRef,
    fetch: fakeFetch,
  },
  document: documentRef,
  console: {
    error: (...args) => consoleErrors.push(args),
    log: () => {},
    warn: () => {},
  },
  KeyboardEvent: class KeyboardEvent {
    constructor(type, init = {}) {
      Object.assign(this, init);
      this.type = type;
    }
  },
  AbortController: class AbortController {
    constructor() {
      this.signal = { aborted: false };
      abortControllers.push(this);
    }
    abort() {
      this.signal.aborted = true;
    }
  },
  Object,
  Symbol,
  Date: { now: () => fakeNow },
  Math: new Proxy(Math, {
    get: (target, prop) =>
      prop === "random"
        ? () => (randoms.length === 0 ? 0 : randoms.shift())
        : Reflect.get(target, prop),
  }),
};
vm.createContext(sandbox);
let script;
try {
  script = new vm.Script(bundle, { filename: clientPath });
  check("bundle parses as a classic script (no ESM syntax)", true);
} catch (error) {
  check("bundle parses as a classic script (no ESM syntax)", false, error.message);
}
if (script !== undefined) {
  try {
    script.runInContext(sandbox);
    check("bundle loads as a classic script and registers its factory", true);
  } catch (error) {
    check("bundle loads as a classic script and registers its factory", false, error.message);
  }
}
//#endregion

//#region bundle registration contract
check("registered exactly one module", registration !== undefined);
check(
  "registered id === package name",
  registration?.id === pkg.name,
  `${registration?.id} vs ${pkg.name}`,
);
// A browser half must reach the page through the combo route alone, so its
// factory may not ask the client module graph for anything.
const required = [];
const exportsObj = typeof registration?.factory === "function"
  ? registration.factory((spec) => {
      required.push(spec);
      return {};
    })
  : undefined;
check("module scope requires nothing", required.length === 0, required.join(", "));
check("exports apply", typeof exportsObj?.apply === "function");
check(
  "declares the locale service it reads",
  Array.isArray(exportsObj.inject) && exportsObj.inject.includes("locale"),
  JSON.stringify(exportsObj.inject),
);
//#endregion

//#region single-context activation: the module's own apply installs every tweak
const shipped = (ns, key) => `shipped:${ns}:${key}`;
const localeState = { active: "zh" };
// `translate` must live on the PROTOTYPE, exactly as LocaleRuntime defines it:
// the tweak shadows it with an own property and restores it by `delete`, which
// only puts the shipped method back when the original was inherited.
function FakeLocale() {}
FakeLocale.prototype.getSnapshot = function getSnapshot() {
  return { active: localeState.active, locales: [], revision: 0 };
};
FakeLocale.prototype.translate = function translate(ns, key) {
  return shipped(ns, key);
};
const locale = new FakeLocale();
const statusLine = () => locale.translate("chat", "chat.deepDiving");

// The settings channel is an OPTIONAL cordis dependency, so the fake context
// implements `inject(deps, callback)` beside `get`, and the scope stands in for
// the mirror-backed per-namespace view: `value` is the resolved section the Host
// would publish, and the listeners are what a committed change notifies.
const scopeState = { value: undefined, listeners: [] };
let scopeReleased = false;
const boundNamespaces = [];
const injectedDeps = [];
const effectLabels = [];
const fakeScope = {
  getSnapshot: () => ({
    status: scopeState.value === undefined ? "unavailable" : "ready",
    value: scopeState.value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: false,
    mode: "memory",
  }),
  subscribe: (listener) => {
    scopeState.listeners.push(listener);
    return () => {
      scopeState.listeners = scopeState.listeners.filter((entry) => entry !== listener);
      scopeReleased = true;
    };
  },
  set: () => Promise.resolve(),
  unset: () => Promise.resolve(),
  mutate: () => Promise.resolve(),
};
const settingsScope = {
  bind: (spec) => {
    boundNamespaces.push(spec.namespace);
    return fakeScope;
  },
};
/** Publish one accepted section the way the mirror does: replace, then notify. */
const adopt = (value) => {
  scopeState.value = value;
  for (const listener of [...scopeState.listeners]) listener();
};

/**
 * The fake client context `apply` is driven with. `services` is what `ctx.get`
 * answers: the one `locale` service the tweaks need, plus the optional
 * `sessions`/`hostInfo` the open-in-editor handler reads. `inject` hands the
 * optional settings channel to its callback, and `effect` records every
 * disposer so teardown can be exercised.
 */
const makeCtx = ({ sessions, hostInfo } = {}) => {
  const disposers = [];
  const services = { locale, sessions, hostInfo };
  const ctx = {
    get: (name) => services[name],
    inject: (deps, callback) => {
      injectedDeps.push(deps);
      callback({ get: ctx.get, effect: ctx.effect, settingsScope });
    },
    effect: (callback, label) => {
      effectLabels.push(label);
      const dispose = callback();
      disposers.push(dispose);
      return dispose;
    },
  };
  return { ctx, disposers };
};

// The session store shape the client `sessions` service publishes: the handler
// reads `list.getSnapshot()` for the current id and its summary's `cwd`.
const sessionsStore = {
  list: {
    getSnapshot: () => ({
      current: "sess-1",
      byId: { "sess-1": { cwd: "/abs/root" } },
    }),
  },
};
// `hostInfo` is the optional host facts the handler reads for `~` expansion.
const hostInfo = { getSnapshot: () => ({ home: "/home/me" }) };

const flush = () => new Promise((resolve) => setImmediate(resolve));
const listenerOn = (doc, type, capture) =>
  doc.listeners.filter((entry) => entry.type === type && entry.capture === capture);

const main = makeCtx({ sessions: sessionsStore, hostInfo });
if (typeof exportsObj?.apply === "function") exportsObj.apply(main.ctx);
// The availability probe is fire-and-forget by contract, so let its microtasks
// settle before asserting the click listener it installs.
await flush();
const mainController = abortControllers.at(-1);

const keydownListeners = listenerOn(documentRef, "keydown", true);
const clickListeners = listenerOn(documentRef, "click", true);
check(
  "the module's own apply installs exactly one capture-phase keydown listener",
  keydownListeners.length === 1,
  `${keydownListeners.length} listener(s)`,
);
check(
  "the module's own apply installs exactly one capture-phase click listener",
  clickListeners.length === 1,
  `${clickListeners.length} listener(s)`,
);
check(
  "both listeners land on the SAME document — the one context's window.document",
  documentRef === sandbox.window.document && documentRef === sandbox.document,
);
check(
  "every ctx.effect call carries a label",
  effectLabels.length > 0 &&
    effectLabels.every((label) => typeof label === "string" && label !== ""),
  JSON.stringify(effectLabels),
);
check(
  "the click handler owns its own labelled effect",
  effectLabels.includes("ui-tweaks: intercept Ctrl/Cmd+click to open a file in the editor"),
);

check("binds exactly one settings namespace", boundNamespaces.length === 1, `${boundNamespaces.length} bind(s)`);
check("binds the ui-tweaks namespace", boundNamespaces[0] === "ui-tweaks", String(boundNamespaces[0]));
check("reaches settings through ctx.inject, not a hard dependency", JSON.stringify(injectedDeps) === JSON.stringify([["settingsScope"]]), JSON.stringify(injectedDeps));
check("settingsScope is not a hard inject dependency", !exportsObj.inject.includes("settingsScope"), JSON.stringify(exportsObj.inject));
check("subscribes to the bound scope", scopeState.listeners.length === 1, `${scopeState.listeners.length} listener(s)`);
//#endregion

//#region status wording tweak (through the one locale service)
const first = statusLine();
check("the running-turn line is reworded in a Chinese UI", typeof first === "string" && first.length > 0 && first !== shipped("chat", "chat.deepDiving"), first);
// No section has been published yet: the reworded line above, and the Enter
// interception the region below asserts, are the schema defaults at work.
check("no accepted section yet, so the tweak set is on its schema defaults", scopeState.value === undefined, String(scopeState.value));
check("other chat copy passes through untouched", locale.translate("chat", "chat.loadOlder") === shipped("chat", "chat.loadOlder"));
check("other namespaces pass through untouched", locale.translate("common", "chat.deepDiving") === shipped("common", "chat.deepDiving"));
check("the wording is stable within one run", statusLine() === first, `${statusLine()} vs ${first}`);
fakeNow += 3_000;
randoms.push(0);
const second = statusLine();
check("a new run draws again", second !== shipped("chat", "chat.deepDiving") && second.length > 0, second);
check("a new run does not repeat the previous wording", second !== first, `${second} vs ${first}`);
localeState.active = "en";
check("an English UI keeps the shipped wording", statusLine() === shipped("chat", "chat.deepDiving"), statusLine());
localeState.active = "zh-CN";
fakeNow += 3_000;
randoms.push(0);
check("a regional Chinese locale is still reworded", statusLine() !== shipped("chat", "chat.deepDiving"));
localeState.active = "zh";
//#endregion

//#region Enter tweak behaviour against the same fake document
const onKeyDown = keydownListeners[0]?.fn;
check("the module's own apply exposes a callable keydown handler", typeof onKeyDown === "function");

const dispatched = [];
/** The composer root: `closest` resolves to the element itself, as in the DOM. */
const makeComposer = (editable) => {
  const composer = {
    isContentEditable: editable,
    closest: (selector) => (selector === "[data-composer-input]" ? composer : null),
    dispatchEvent: (event) => {
      dispatched.push(event);
      return true;
    },
  };
  return composer;
};
const keydown = (init) => ({
  key: "Enter",
  defaultPrevented: false,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 13,
  target: { closest: () => null },
  preventDefault() { this.defaultPrevented = true; },
  stopImmediatePropagation() { this.stopped = true; },
  ...init,
});

const run = (event) => {
  dispatched.length = 0;
  if (typeof onKeyDown === "function") onKeyDown(event);
  return { intercepted: event.defaultPrevented === true && event.stopped === true, dispatched };
};

const bare = run(keydown({ target: makeComposer(true) }));
check("bare Enter in the composer is intercepted", bare.intercepted);
check(
  "bare Enter replays as a synthetic Shift+Enter",
  bare.dispatched.length === 1 &&
    bare.dispatched[0].key === "Enter" &&
    bare.dispatched[0].shiftKey === true &&
    bare.dispatched[0].bubbles === true &&
    bare.dispatched[0].cancelable === true,
);
check("Ctrl+Enter is left to the shipped keymap", run(keydown({ ctrlKey: true, target: makeComposer(true) })).intercepted === false);
check("Cmd+Enter is left to the shipped keymap", run(keydown({ metaKey: true, target: makeComposer(true) })).intercepted === false);
check("Shift+Enter is left to the shipped keymap", run(keydown({ shiftKey: true, target: makeComposer(true) })).intercepted === false);
check("an IME-closing Enter is left alone", run(keydown({ isComposing: true, target: makeComposer(true) })).intercepted === false);
check("Enter outside the composer is left alone", run(keydown({ target: { closest: () => null } })).intercepted === false);
check("Enter in the inert composer state is left alone", run(keydown({ target: makeComposer(false) })).intercepted === false);
menuOpen = true;
check("Enter with a suggestion menu open is left alone", run(keydown({ target: makeComposer(true) })).intercepted === false);
menuOpen = false;
const repeat = run(keydown({ repeat: true, target: makeComposer(true) }));
check("a held Enter keeps breaking lines", repeat.intercepted && repeat.dispatched.length === 1);
check("a non-Enter key is left alone", run(keydown({ key: "a", target: makeComposer(true) })).intercepted === false);
check("an already-defaultPrevented Enter is left alone", run(keydown({ defaultPrevented: true, target: makeComposer(true) })).intercepted === false);
//#endregion

//#region settings-driven behaviour (the ui-tweaks namespace)
// The section shape is the one the node half's schema declares, and the host
// check pins that the two halves name the same fields. What is checked here is
// what the PAGE does with an adopted section: an edit arrives through the scope
// subscription alone — no re-install, no reload — and each field switches only
// its own tweak.
adopt({ composerEnterNewline: false, statusWording: true, statusPhrases: [] });
check("composerEnterNewline: false leaves bare Enter to the shipped keymap", run(keydown({ target: makeComposer(true) })).intercepted === false);
check("composerEnterNewline: false still lets Ctrl+Enter through", run(keydown({ ctrlKey: true, target: makeComposer(true) })).intercepted === false);

adopt({ composerEnterNewline: true, statusWording: false, statusPhrases: [] });
check("statusWording: false restores the shipped running-turn copy", statusLine() === shipped("chat", "chat.deepDiving"), statusLine());
check("statusWording: false leaves other chat copy alone", locale.translate("chat", "chat.loadOlder") === shipped("chat", "chat.loadOlder"));
check("composerEnterNewline: true comes back without a re-install", run(keydown({ target: makeComposer(true) })).intercepted);
check("the page still carries one keydown listener", listenerOn(documentRef, "keydown", true).length === 1, `${listenerOn(documentRef, "keydown", true).length} left`);
check(
  "no settings field re-installs or removes the click handler's listener",
  listenerOn(documentRef, "click", true).length === 1,
  `${listenerOn(documentRef, "click", true).length} left`,
);

// The extension list JOINS the shipped bank, and the dice are pinned to the last
// index of the effective bank, so the draw lands on the extension's last entry.
adopt({ composerEnterNewline: true, statusWording: true, statusPhrases: ["自定义甲", "自定义乙"] });
fakeNow += 3_000;
randoms.push(0.999999);
check("an extended phrase is drawn from the appended end", statusLine() === "自定义乙", statusLine());
fakeNow += 3_000;
randoms.push(0);
const shippedDraw = statusLine();
check(
  "the shipped phrases are still in the bank",
  shippedDraw !== "自定义乙" && shippedDraw !== shipped("chat", "chat.deepDiving") && shippedDraw.length > 0,
  shippedDraw,
);

// Blank and non-string entries are the shape a hand-edited settings.yaml really
// produces; they must not enter the bank (a blank status line would read as a
// broken page) and must not disable the tweak.
adopt({ composerEnterNewline: true, statusWording: true, statusPhrases: ["", "   ", 42, null, "有效的一句"] });
fakeNow += 3_000;
randoms.push(0.999999);
check("blank and non-string entries never reach the bank", statusLine() === "有效的一句", statusLine());

// A section the page cannot read (an unanswered read, a hand-edit the schema
// rejected, a namespace that went away) keeps the last accepted values.
adopt(undefined);
check("an absent section keeps the Enter tweak on", run(keydown({ target: makeComposer(true) })).intercepted);
check("an absent section keeps the wording tweak on", statusLine() !== shipped("chat", "chat.deepDiving"), statusLine());
adopt("not a section");
check("a malformed section keeps the adopted values", run(keydown({ target: makeComposer(true) })).intercepted);
//#endregion

//#region open-in-editor: reached only through the module's own activation
//
// The handler is internal to the factory now (`applyOpenInEditor`), so there is
// no exported function to unit-test: every decision below is observed by
// dispatching a hand-built click at the capturing listener that `apply` itself
// installed on the fake document, and reading the one fake `window.fetch`.
//
// THIS IS THE REGRESSION. Under the former two-file design the factory looked
// for `window.__dshDotdshOpenInEditor`, which only the injected sibling script
// could set; that sibling has no route in a one-script sandbox (a real page
// 404s it), so this `clickListeners.length === 1` assertion found ZERO listeners
// and failed. Nothing here ever loads a second file.
const STATUS_ROUTE = "/ui-tweaks/open-in-vscode/status";
const LAUNCH_ROUTE = "/ui-tweaks/open-in-vscode/launch";

const clickHandler = clickListeners[0]?.fn;
check("the module's own apply exposes a callable click handler", typeof clickHandler === "function");

/** A minimal element whose `closest` walks the fake parent chain by attribute. */
const makeElement = (tag, attrs = {}, parent = null) => {
  const node = {
    tagName: tag,
    parentElement: parent,
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
    matches(selector) {
      if (selector === "button[title]") return tag === "button" && node.getAttribute("title") !== null;
      if (selector === 'li[data-files-entry="file"][data-files-path]') {
        return tag === "li" && node.getAttribute("data-files-entry") === "file" && node.getAttribute("data-files-path") !== null;
      }
      return false;
    },
    closest(selector) {
      let current = node;
      while (current !== null && current !== undefined) {
        if (typeof current.matches === "function" && current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  return node;
};

const postCalls = () => fetchCalls.filter((call) => call.method === "POST");
const lastPostBody = () => {
  const call = postCalls().at(-1);
  if (call === undefined) return {};
  try {
    return JSON.parse(call.init.body);
  } catch {
    return {};
  }
};
const clickEventFor = (target, init = {}) => ({
  button: 0,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  target,
  defaultPrevented: false,
  immediateStopped: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopImmediatePropagation() {
    this.immediateStopped = true;
  },
  ...init,
});
const dispatchClick = (target, init) => {
  fetchCalls.length = 0;
  const event = clickEventFor(target, init);
  if (typeof clickHandler === "function") clickHandler(event);
  return event;
};
const claimed = (event) => event.defaultPrevented === true && event.immediateStopped === true;

// The produced-files card: `div[data-presented-file]` CONTAINING the preview
// `button[title="/abs/path"]`. The card's split button and a titled button
// outside any card name nothing.
const card = makeElement("div", { "data-presented-file": "" });
const previewButton = makeElement("button", { title: "/abs/path/to/file.ts" }, card);

const ctrlCard = dispatchClick(previewButton, { ctrlKey: true });
check("a Ctrl+click on a produced-files card is claimed with preventDefault", ctrlCard.defaultPrevented === true);
check(
  "a Ctrl+click on a produced-files card is claimed with stopImmediatePropagation, not only stopPropagation",
  ctrlCard.immediateStopped === true,
);
const ctrlPost = postCalls()[0];
check(
  "the claimed click POSTs the launch route with the card's path and the session id ctx.get('sessions') supplied",
  ctrlPost !== undefined &&
    ctrlPost.url === LAUNCH_ROUTE &&
    ctrlPost.init.method === "POST" &&
    ctrlPost.init.headers?.["content-type"] === "application/json" &&
    lastPostBody().path === "/abs/path/to/file.ts" &&
    lastPostBody().sessionId === "sess-1",
  JSON.stringify(ctrlPost),
);
check(
  "the launch is tied to the plugin lifetime's abort signal",
  ctrlPost?.init.signal === mainController.signal && mainController.signal.aborted === false,
);

const cmdCard = dispatchClick(previewButton, { metaKey: true });
check("a Cmd+click on a produced-files card is claimed too", claimed(cmdCard));
check("the Cmd+click POSTs the same launch route", postCalls()[0]?.url === LAUNCH_ROUTE);

const plainCard = dispatchClick(previewButton);
check("a plain click on the same card is left to dsh (not claimed)", plainCard.defaultPrevented === false && plainCard.immediateStopped === false);
check("a plain click POSTs nothing", postCalls().length === 0);

// The gesture matrix: Ctrl or Cmd with the primary button, nothing else.
for (const [label, init, expected] of [
  ["Ctrl + primary button", { ctrlKey: true }, true],
  ["Cmd + primary button", { metaKey: true }, true],
  ["a plain click", {}, false],
  ["a middle click", { button: 1, ctrlKey: true }, false],
  ["a right click", { button: 2, ctrlKey: true }, false],
  ["shift-only", { shiftKey: true }, false],
  ["alt-only", { altKey: true }, false],
]) {
  const event = dispatchClick(previewButton, init);
  check(
    `the gesture is ${expected ? "claimed" : "left to dsh"} for ${label}`,
    claimed(event) === expected && (postCalls().length > 0) === expected,
    JSON.stringify(init),
  );
}

// The card's split button (no title), a titled button outside any card, and the
// header breadcrumb all name nothing and must be left to dsh.
const splitButton = makeElement("button", {}, card);
const splitEvent = dispatchClick(splitButton, { ctrlKey: true });
check("a click on the card's split button (no title) is left to dsh", !claimed(splitEvent) && postCalls().length === 0);

const looseButton = makeElement("button", { title: "/abs/loose.ts" });
const looseEvent = dispatchClick(looseButton, { ctrlKey: true });
check("a titled button that is not inside a card is left to dsh", !claimed(looseEvent) && postCalls().length === 0);

// The sidebar row: `li[data-files-entry="file"][data-files-path]` under a
// `div[data-files-root]`; the header breadcrumb has the path attribute but no
// entry kind, and a non-element has no `closest` at all.
const treeRoot = makeElement("div", { "data-files-root": "/abs/root" });
const fileRow = makeElement("li", { "data-files-entry": "file", "data-files-path": "src/app.ts" }, treeRoot);
const rowEvent = dispatchClick(fileRow, { ctrlKey: true });
check(
  "a Ctrl+click on the sidebar file row joins its root and its relative path",
  claimed(rowEvent) && lastPostBody().path === "/abs/root/src/app.ts",
  JSON.stringify(lastPostBody()),
);
const absoluteRow = makeElement("li", { "data-files-entry": "file", "data-files-path": "/already/abs.ts" }, treeRoot);
dispatchClick(absoluteRow, { ctrlKey: true });
check("an already-absolute sidebar path is sent unchanged", lastPostBody().path === "/already/abs.ts", String(lastPostBody().path));
const breadcrumb = makeElement("div", { "data-files-path": "src/app.ts" }, treeRoot);
const breadcrumbEvent = dispatchClick(breadcrumb, { ctrlKey: true });
check("the header breadcrumb (no entry kind) is left to dsh", !claimed(breadcrumbEvent) && postCalls().length === 0);
for (const [label, target] of [
  ["a plain object", {}],
  ["a null", null],
  ["an undefined", undefined],
]) {
  const event = dispatchClick(target, { ctrlKey: true });
  check(`${label} click target is left to dsh`, !claimed(event) && postCalls().length === 0);
}

// The PRODUCED-FILES ROW ("本轮文件改动"): a lane whose file buttons carry the
// absolute path in their own `title`, with NO `data-presented-file` ancestor.
// This shape is why the tweak silently did nothing there for two rounds: an
// implementation that demanded the delivered-file CARD could never match it, and
// no check covered it. Its markup, verbatim from a live page:
//   <div data-produced-files-row="true">
//     <button class="P4kPIW_file" title="/abs/x.ts"><svg/><span>x.ts</span></button>
//   </div>
const producedRow = makeElement("div", { "data-produced-files-row": "" });
const producedFile = makeElement("button", { title: "/abs/produced.ts" }, producedRow);
const producedEvent = dispatchClick(producedFile, { ctrlKey: true });
check(
  "a Ctrl+click on the produced-files row is claimed and sends its title",
  claimed(producedEvent) && lastPostBody().path === "/abs/produced.ts",
  JSON.stringify(lastPostBody()),
);
check("a plain click on the produced-files row is left to dsh", !claimed(dispatchClick(producedFile, {})));

// ... and the SAME button inside message prose is deliberately NOT claimed. Its
// only container is the whole message body, so claiming it would take ordinary
// text selection away from the user; the row and the card are the file surfaces,
// prose is not. Markup, again verbatim:
//   <div class="_markdown_…"><p>…<code><button class="_fileMention_…" title="/abs/x.ts">…</button></code></p></div>
const messageBody = makeElement("div", { class: "_markdown_kcgor_5" });
const paragraph = makeElement("p", {}, messageBody);
const codeEl = makeElement("code", {}, paragraph);
const mention = makeElement("button", { class: "_fileMention_kcgor_304", title: "/abs/mentioned.ts" }, codeEl);
const mentionEvent = dispatchClick(mention, { ctrlKey: true });
check(
  "a file mention in message prose is left to dsh (no over-reach into text)",
  !claimed(mentionEvent) && postCalls().length === 0,
);
// A titled control inside the row that is not a file is still not a file: the
// path test guards the buttons WITHIN the surface, so a labelled button stays.
const labelled = makeElement("button", { title: "刷新" }, producedRow);
const labelledEvent = dispatchClick(labelled, { ctrlKey: true });
check("a non-path titled button inside the row is left to dsh", !claimed(labelledEvent) && postCalls().length === 0);

// Path resolution, observed through the POST body: the spellings dsh accepts
// pass through, `~` is expanded against the host home, and a relative path joins
// the session cwd.
for (const [label, target, expected] of [
  ["a POSIX absolute card title", makeElement("button", { title: "/a/b" }, card), "/a/b"],
  ["a Windows drive card title", makeElement("button", { title: "C:\\a\\b" }, card), "C:\\a\\b"],
  ["a Windows drive card title with forward slashes", makeElement("button", { title: "C:/a" }, card), "C:/a"],
  ["a UNC card title", makeElement("button", { title: "\\\\srv\\share\\x" }, card), "\\\\srv\\share\\x"],
  ["a ~ sidebar path", makeElement("li", { "data-files-entry": "file", "data-files-path": "~/x" }), "/home/me/x"],
  ["a rootless relative sidebar path", makeElement("li", { "data-files-entry": "file", "data-files-path": "sub/f" }), "/abs/root/sub/f"],
]) {
  dispatchClick(target, { ctrlKey: true });
  check(`${label} resolves to ${expected}`, lastPostBody().path === expected, String(lastPostBody().path));
}

// Launch failures are reported, never thrown, and never un-claim the click.
consoleErrors.length = 0;
launchAnswer = () => Promise.reject(new Error("boom"));
const failedLaunch = dispatchClick(previewButton, { ctrlKey: true });
check("a failed launch keeps the click claimed", claimed(failedLaunch));
await flush();
check(
  "a rejected launch reports exactly one console line and does not throw",
  consoleErrors.length === 1 && String(consoleErrors[0][0]).includes("launch request failed"),
  JSON.stringify(consoleErrors),
);
consoleErrors.length = 0;
launchAnswer = () => Promise.resolve({ ok: false, status: 500 });
dispatchClick(previewButton, { ctrlKey: true });
await flush();
check(
  "a non-2xx launch reports the status",
  consoleErrors.length === 1 && consoleErrors[0][1] === 500,
  JSON.stringify(consoleErrors),
);
launchAnswer = () => Promise.resolve({ ok: true, status: 200 });
//#endregion

//#region teardown of the one activation
for (const dispose of main.disposers) dispose();
check("disposing removes the document keydown listener", listenerOn(documentRef, "keydown", true).length === 0, `${listenerOn(documentRef, "keydown", true).length} left`);
check("disposing removes the document click listener", listenerOn(documentRef, "click", true).length === 0, `${listenerOn(documentRef, "click", true).length} left`);
check("disposing aborts the launch signal", mainController.signal.aborted === true);
check("disposing releases the settings subscription", scopeReleased && scopeState.listeners.length === 0, `${scopeState.listeners.length} left`);
check(
  "disposing restores the shipped wording",
  statusLine() === shipped("chat", "chat.deepDiving") && !Object.prototype.hasOwnProperty.call(locale, "translate"),
  statusLine(),
);
//#endregion

//#region every answer but a 200 {available:true} parks only the click handler
//
// The host route alone decides availability, so a probe that cannot answer must
// leave the other tweaks mounted and install no click listener at all: dsh's own
// preview then keeps every click, exactly as before the tweak existed.
for (const [label, impl] of [
  ["a non-2xx response", () => Promise.resolve({ ok: false, status: 503, json: async () => ({ available: true }) })],
  ["a rejecting fetch", () => Promise.reject(new Error("network down"))],
  ["a synchronously throwing fetch", () => { throw new Error("sync throw"); }],
  ["a body that is not JSON", () => Promise.resolve({ ok: true, json: async () => { throw new Error("bad json"); } })],
  ["a response without json()", () => Promise.resolve({ ok: true })],
  ["a non-object body", () => Promise.resolve({ ok: true, json: async () => 42 })],
  ["an array body", () => Promise.resolve({ ok: true, json: async () => [] })],
  ["available as a string", () => Promise.resolve({ ok: true, json: async () => ({ available: "yes" }) })],
  ["available as a number", () => Promise.resolve({ ok: true, json: async () => ({ available: 1 }) })],
  ["available: false", () => Promise.resolve({ ok: true, json: async () => ({ available: false, reason: "disabled" }) })],
]) {
  probeImpl = impl;
  const doc = makeDocument();
  sandbox.document = doc;
  sandbox.window.document = doc;
  const scenario = makeCtx({ sessions: sessionsStore, hostInfo });
  exportsObj.apply(scenario.ctx);
  await flush();
  check(
    `the probe installs no click listener for ${label} (the other tweaks still mount)`,
    listenerOn(doc, "click", true).length === 0 && listenerOn(doc, "keydown", true).length === 1,
    `${listenerOn(doc, "click", true).length} click, ${listenerOn(doc, "keydown", true).length} keydown`,
  );
  for (const dispose of scenario.disposers) dispose();
}

// No fetch at all is the same degradation.
probeImpl = () => Promise.resolve({ ok: true, json: async () => ({ available: true }) });
sandbox.window.fetch = undefined;
const noFetchDoc = makeDocument();
sandbox.document = noFetchDoc;
sandbox.window.document = noFetchDoc;
const noFetch = makeCtx({ sessions: sessionsStore, hostInfo });
exportsObj.apply(noFetch.ctx);
await flush();
check(
  "no window.fetch means no click listener, and the other tweaks still mount",
  listenerOn(noFetchDoc, "click", true).length === 0 && listenerOn(noFetchDoc, "keydown", true).length === 1,
);
for (const dispose of noFetch.disposers) dispose();
sandbox.window.fetch = fakeFetch;

// A page that knows neither a session cwd nor a home sends the path as rendered.
const bareDoc = makeDocument();
sandbox.document = bareDoc;
sandbox.window.document = bareDoc;
const noFacts = makeCtx();
exportsObj.apply(noFacts.ctx);
await flush();
const bareClick = listenerOn(bareDoc, "click", true)[0]?.fn;
check("a context without sessions still installs the click listener", typeof bareClick === "function");
const bareDispatch = (target) => {
  fetchCalls.length = 0;
  const event = clickEventFor(target, { ctrlKey: true });
  if (typeof bareClick === "function") bareClick(event);
  return event;
};
const bareRelative = bareDispatch(makeElement("li", { "data-files-entry": "file", "data-files-path": "sub/f" }));
check(
  "with neither a home nor a cwd the relative path is sent as rendered (the host rejects it)",
  claimed(bareRelative) && lastPostBody().path === "sub/f" && lastPostBody().sessionId === undefined,
  JSON.stringify(lastPostBody()),
);
const bareHome = bareDispatch(makeElement("li", { "data-files-entry": "file", "data-files-path": "~/x" }));
check(
  "an unknown home leaves a ~ path abbreviated",
  claimed(bareHome) && lastPostBody().path === "~/x",
  String(lastPostBody().path),
);
for (const dispose of noFacts.disposers) dispose();
//#endregion

console.log(
  failures.length === 0
    ? "\nall checks passed"
    : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
