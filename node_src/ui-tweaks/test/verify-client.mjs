// The committed check for the ui-tweaks browser half. Run: pnpm test
//
// `client/index.js` and its injected sibling `client/clicked-file.js` are the
// files in this repository with no compiler behind them: `tsc` only builds
// `src/`, and dsh serves those exact bytes to the page, failing the boot when a
// file is missing. This script is their gate. It mirrors what dsh's
// client-modules scanner reads out of the package manifest, loads the browser
// half in a `node:vm` sandbox under a fake `window.__ModuleLoader__`, and
// asserts every decision the three tweaks make against a fake DOM, a fake locale
// service, and a fake settings scope (the mirror-backed per-namespace view the
// page reads its configuration from). `clicked-file.js` is loaded through the
// same classic-script entry point the page uses and reaches the same global.
// Built-ins only (`node:vm|fs|path|url`), so a clean checkout runs it with plain
// Node — no test framework, no dependency, no harness, no network.
//
// What a green run does NOT mean: there is no React, no Lexical, no locale
// service, no settings transport and no browser in here. The Enter checks assert
// the shape of the synthetic event the tweak re-emits, not that Lexical inserted
// a line break; the wording checks assert what the locale wrapper returns, not
// that the page re-rendered the new text; the settings checks publish a section
// into the fake scope directly, so they prove what the page does with one, not
// that dsh resolved, delivered or persisted it (that seam is the host half's own
// check, test/verify-host.mjs). The clicked-file checks feed hand-built element
// objects to `fileFromClickTarget`, so they prove which attributes and gestures
// the handler selects and what it posts, not that a real DOM produced those
// elements, that the injected sibling script has loaded by the time the factory
// reads the global, or that a real browser dispatch reached the handler. Whether
// any tweak works end to end is settled by loading the page once.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
const bundle = readFileSync(clientPath, "utf8");
// The boot registration injects its sibling `clicked-file.js` beside itself, so
// that file must ship too: a package that omits it boots a page whose
// Ctrl/Cmd+click handler silently never arrives.
const siblingRel = "client/clicked-file.js";
check(
  "the injected sibling clicked-file.js exists and ships in package.files",
  existsSync(join(pkgDir, siblingRel)) && (pkg.files ?? []).includes(siblingRel),
  String(pkg.files),
);
//#endregion

//#region bundle registration contract
let registration;
const sandbox = {
  window: { __ModuleLoader__: { load: (reg) => { registration = reg; } } },
  Object,
  Symbol,
};
vm.createContext(sandbox);
try {
  new vm.Script(bundle, { filename: clientPath });
  check("bundle parses as a classic script (no ESM syntax)", true);
} catch (error) {
  check("bundle parses as a classic script (no ESM syntax)", false, error.message);
}
sandbox.KeyboardEvent = class KeyboardEvent {
  constructor(type, init = {}) {
    Object.assign(this, init);
    this.type = type;
  }
};
const listeners = [];
let menuOpen = false;
sandbox.document = {
  addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }),
  removeEventListener: (type, fn, capture) => {
    const index = listeners.findIndex(
      (l) => l.type === type && l.fn === fn && l.capture === capture,
    );
    if (index >= 0) listeners.splice(index, 1);
  },
  querySelector: () => (menuOpen ? { marker: "listbox" } : null),
};
// The wording tweak draws from the page realm's Math/Date: pin both so its
// re-draw rule (not the dice) is what the checks below assert.
let fakeNow = 1_000_000;
const randoms = [];
sandbox.Date = { now: () => fakeNow };
sandbox.Math = new Proxy(Math, {
  get: (target, prop) =>
    prop === "random" ? () => (randoms.length === 0 ? 0 : randoms.shift()) : Reflect.get(target, prop),
});
new vm.Script(bundle, { filename: clientPath }).runInContext(sandbox);
check("registered exactly one module", registration !== undefined);
check(
  "registered id === package name",
  registration?.id === pkg.name,
  `${registration?.id} vs ${pkg.name}`,
);
let requires = [];
const exportsObj = registration.factory((spec) => {
  requires.push(spec);
  throw new Error(`unexpected require: ${spec}`);
});
check("module scope requires nothing", requires.length === 0, requires.join(", "));
check("exports apply", typeof exportsObj.apply === "function");
check(
  "declares the locale service it reads",
  Array.isArray(exportsObj.inject) && exportsObj.inject.includes("locale"),
  JSON.stringify(exportsObj.inject),
);
//#endregion

//#region tweak behaviour against a fake locale service + DOM
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

const disposers = [];
const ctx = {
  get: (name) => (name === "locale" ? locale : undefined),
  inject: (deps, callback) => {
    injectedDeps.push(deps);
    callback({ get: ctx.get, effect: ctx.effect, settingsScope });
  },
  effect: (callback, label) => {
    check("ctx.effect label is set", typeof label === "string", String(label));
    const dispose = callback();
    disposers.push(dispose);
    return dispose;
  },
};
exportsObj.apply(ctx);

check("binds exactly one settings namespace", boundNamespaces.length === 1, `${boundNamespaces.length} bind(s)`);
check("binds the ui-tweaks namespace", boundNamespaces[0] === "ui-tweaks", String(boundNamespaces[0]));
check("reaches settings through ctx.inject, not a hard dependency", JSON.stringify(injectedDeps) === JSON.stringify([["settingsScope"]]), JSON.stringify(injectedDeps));
check("settingsScope is not a hard inject dependency", !exportsObj.inject.includes("settingsScope"), JSON.stringify(exportsObj.inject));
check("subscribes to the bound scope", scopeState.listeners.length === 1, `${scopeState.listeners.length} listener(s)`);

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

//#region Enter tweak behaviour against the fake DOM
check("installs one capture-phase document keydown listener", listeners.length === 1 && listeners[0].type === "keydown" && listeners[0].capture === true);
const onKeyDown = listeners[0].fn;

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
  onKeyDown(event);
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
check("the page still carries one document listener", listeners.length === 1, `${listeners.length} left`);

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

//#region teardown
for (const dispose of disposers) dispose();
check("disposing removes the document listener", listeners.length === 0, `${listeners.length} left`);
check("disposing releases the settings subscription", scopeReleased && scopeState.listeners.length === 0, `${scopeState.listeners.length} left`);
check(
  "disposing restores the shipped wording",
  statusLine() === shipped("chat", "chat.deepDiving") && !Object.prototype.hasOwnProperty.call(locale, "translate"),
  statusLine(),
);
//#endregion

//#region clicked-file.js: the open-in-editor handler in its own classic script
// `client/index.js` injects `client/clicked-file.js` as a sibling classic script
// and reads its exports off `window.__dshDotdshOpenInEditor`. This region loads
// that exact file the way a browser would (a `node:vm` classic script reaching
// the same global) and drives its decisions with a minimal fake DOM. The DOM is
// still fake: what is proved is that the file selects the documented attributes
// and gestures, builds the documented path, and produces the host call — not
// that a real browser dispatched a real click to it.
const clickedPath = join(pkgDir, siblingRel);
const clickedSrc = readFileSync(clickedPath, "utf8");
const clickedSandbox = {
  window: {},
  console: { error: () => {}, log: () => {} },
  Object,
  Array,
  JSON,
  Math,
  Date,
  Promise,
  Symbol,
  Error,
  TypeError,
};
vm.createContext(clickedSandbox);
let clickedParsed = true;
try {
  new vm.Script(clickedSrc, { filename: clickedPath }).runInContext(clickedSandbox);
} catch (error) {
  clickedParsed = false;
  check("clicked-file.js parses and runs as a classic script", false, error.message);
}
if (clickedParsed) check("clicked-file.js parses and runs as a classic script", true);
const clicked = clickedSandbox.window.__dshDotdshOpenInEditor ?? {};
check(
  "clicked-file.js publishes its handler exports on the global",
  ["fileFromClickTarget", "isOpenInEditorGesture", "absolutePathFor", "probeEditorStatus", "apply"].every(
    (name) => typeof clicked[name] === "function",
  ),
);

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

// 20. The produced-files card: `div[data-presented-file]` CONTAINING the
//     preview `button[title="/abs/path"]`; the card's split button and a titled
//     button outside any card name nothing.
const card = makeElement("div", { "data-presented-file": "" });
const previewButton = makeElement("button", { title: "/abs/path/to/file.ts" }, card);
const cardHit = clicked.fileFromClickTarget(previewButton);
check(
  "the produced-files card's titled button yields its absolute path",
  cardHit !== null && cardHit.path === "/abs/path/to/file.ts",
  JSON.stringify(cardHit),
);
const splitButton = makeElement("button", {}, card);
check("a click on the card's split button (no title) yields nothing", clicked.fileFromClickTarget(splitButton) === null);
const looseButton = makeElement("button", { title: "/abs/loose.ts" });
check("a titled button that is not inside a card yields nothing", clicked.fileFromClickTarget(looseButton) === null);

// 21. The sidebar row: `li[data-files-entry="file"][data-files-path]` under a
//     `div[data-files-root]`; the header breadcrumb has the path attribute but
//     no entry kind, and a non-element has no `closest` at all.
const treeRoot = makeElement("div", { "data-files-root": "/abs/root" });
const fileRow = makeElement("li", { "data-files-entry": "file", "data-files-path": "src/app.ts" }, treeRoot);
const rowHit = clicked.fileFromClickTarget(fileRow);
check(
  "the sidebar file row joins its root and its relative path",
  rowHit !== null && rowHit.path === "/abs/root/src/app.ts",
  JSON.stringify(rowHit),
);
const absoluteRow = makeElement("li", { "data-files-entry": "file", "data-files-path": "/already/abs.ts" }, treeRoot);
check("an already-absolute sidebar path is returned unchanged", clicked.fileFromClickTarget(absoluteRow)?.path === "/already/abs.ts");
const breadcrumb = makeElement("div", { "data-files-path": "src/app.ts" }, treeRoot);
check("the header breadcrumb (no entry kind) yields nothing", clicked.fileFromClickTarget(breadcrumb) === null);
check(
  "a non-element click target yields nothing",
  clicked.fileFromClickTarget({}) === null && clicked.fileFromClickTarget(null) === null && clicked.fileFromClickTarget(undefined) === null,
);

// 22. The gesture: Ctrl or Cmd with the primary button, nothing else.
for (const [label, event, expected] of [
  ["Ctrl + primary button", { button: 0, ctrlKey: true }, true],
  ["Cmd + primary button", { button: 0, metaKey: true }, true],
  ["a plain click", { button: 0 }, false],
  ["a middle click", { button: 1, ctrlKey: true }, false],
  ["a right click", { button: 2, ctrlKey: true }, false],
  ["shift-only", { button: 0, shiftKey: true }, false],
  ["alt-only", { button: 0, altKey: true }, false],
]) {
  check(`isOpenInEditorGesture is ${expected} for ${label}`, clicked.isOpenInEditorGesture(event) === expected, JSON.stringify(event));
}
check("isOpenInEditorGesture is false for a null event", clicked.isOpenInEditorGesture(null) === false);

// 23. absolutePathFor: the spellings the host accepts pass through, `~` is
//     expanded only when a home is known, and a relative path joins the cwd.
check("absolutePathFor keeps a POSIX absolute path", clicked.absolutePathFor("/ws", "/a/b", "/home/me") === "/a/b");
check("absolutePathFor keeps a Windows drive path", clicked.absolutePathFor("/ws", "C:\\a\\b", "/home/me") === "C:\\a\\b");
check("absolutePathFor keeps a Windows drive path with forward slashes", clicked.absolutePathFor("/ws", "C:/a", "/home/me") === "C:/a");
check("absolutePathFor keeps a UNC path", clicked.absolutePathFor("/ws", "\\\\srv\\share\\x", "/home/me") === "\\\\srv\\share\\x");
check("absolutePathFor expands ~ against the known home", clicked.absolutePathFor("/ws", "~/x", "/home/me") === "/home/me/x");
check("absolutePathFor leaves ~ alone when the home is unknown", clicked.absolutePathFor("/ws", "~/x", undefined) === "~/x");
check("absolutePathFor joins a relative path onto the cwd", clicked.absolutePathFor("/ws", "sub/f", "/home/me") === "/ws/sub/f");
check(
  "absolutePathFor leaves a relative path alone with neither home nor cwd",
  clicked.absolutePathFor(undefined, "sub/f", undefined) === "sub/f",
);

// 24. probeEditorStatus: the status object on a clean 200, and `{available:false}`
//     for every other answer; it must never throw.
const statusCalls = [];
const okStatus = await clicked.probeEditorStatus((url, init) => {
  statusCalls.push({ url, init });
  return Promise.resolve({ ok: true, json: async () => ({ available: true, executable: "/usr/bin/code" }) });
});
check(
  "probeEditorStatus reports available with the executable on a 200 object",
  okStatus.available === true && okStatus.executable === "/usr/bin/code",
  JSON.stringify(okStatus),
);
check(
  "probeEditorStatus asks the documented route with GET",
  statusCalls[0]?.url === "/ui-tweaks/open-in-vscode/status" && statusCalls[0]?.init?.method === "GET",
  JSON.stringify(statusCalls[0]),
);
for (const [label, fetchImpl] of [
  ["a non-2xx response", () => Promise.resolve({ ok: false, status: 503, json: async () => ({ available: true }) })],
  ["a rejecting fetch", () => Promise.reject(new Error("network down"))],
  ["a synchronously throwing fetch", () => { throw new Error("sync throw"); }],
  ["a body that is not JSON", () => Promise.resolve({ ok: true, json: async () => { throw new Error("bad json"); } })],
  ["a response without json()", () => Promise.resolve({ ok: true })],
  ["a non-object body", () => Promise.resolve({ ok: true, json: async () => 42 })],
  ["an array body", () => Promise.resolve({ ok: true, json: async () => [] })],
  ["available as a string", () => Promise.resolve({ ok: true, json: async () => ({ available: "yes" }) })],
  ["available as a number", () => Promise.resolve({ ok: true, json: async () => ({ available: 1 }) })],
]) {
  let result;
  let threw = false;
  try {
    result = await clicked.probeEditorStatus(fetchImpl);
  } catch {
    threw = true;
  }
  check(
    `probeEditorStatus is {available:false} and never throws for ${label}`,
    !threw && result !== undefined && result.available === false,
    threw ? "threw" : JSON.stringify(result),
  );
}
let absentResult;
let absentThrew = false;
try {
  absentResult = await clicked.probeEditorStatus(undefined);
} catch {
  absentThrew = true;
}
check("probeEditorStatus is {available:false} when fetch is absent", !absentThrew && absentResult?.available === false);
const filteredStatus = await clicked.probeEditorStatus(() =>
  Promise.resolve({ ok: true, json: async () => ({ available: true, executable: 42, reason: 7 }) }),
);
check(
  "probeEditorStatus keeps only string diagnostics",
  filteredStatus.available === true && filteredStatus.executable === undefined && filteredStatus.reason === undefined,
  JSON.stringify(filteredStatus),
);

// 25. apply: the probe's answer alone decides whether ONE capturing listener is
//     installed; the claimed path sets BOTH preventDefault and the strong
//     stopImmediatePropagation; the effect disposer removes it again.
const makeDocument = () => {
  const listeners = [];
  return {
    listeners,
    addEventListener(type, fn, capture) {
      listeners.push({ type, fn, capture });
    },
    removeEventListener(type, fn, capture) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn && entry.capture === capture);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
};
const makeEffectCtx = () => {
  const disposers = [];
  return {
    disposers,
    get: () => undefined,
    effect: (callback) => {
      const dispose = callback();
      disposers.push(dispose);
      return dispose;
    },
  };
};

const applyCalls = [];
clickedSandbox.window.fetch = (url, init = {}) => {
  applyCalls.push({ url, method: init.method ?? "GET", init });
  if ((init.method ?? "GET") === "GET") return Promise.resolve({ ok: true, json: async () => ({ available: true }) });
  return Promise.resolve({ ok: true, status: 200 });
};
const applyDoc = makeDocument();
const applyCtx = makeEffectCtx();
clicked.apply(applyCtx, applyDoc);
await new Promise((resolve) => setImmediate(resolve));
check(
  "apply installs exactly one capturing click listener when the probe says yes",
  applyDoc.listeners.length === 1 && applyDoc.listeners[0].type === "click" && applyDoc.listeners[0].capture === true,
  `${applyDoc.listeners.length} listener(s)`,
);
check("apply keeps the effect disposer", applyCtx.disposers.length === 1 && typeof applyCtx.disposers[0] === "function");
check(
  "apply probes the status route exactly once",
  applyCalls.filter((call) => call.method === "GET" && call.url === "/ui-tweaks/open-in-vscode/status").length === 1,
  JSON.stringify(applyCalls),
);

const clickCard = makeElement("div", { "data-presented-file": "" });
const clickButton = makeElement("button", { title: "/abs/clicked.ts" }, clickCard);
const clickEvent = {
  button: 0,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  target: clickButton,
  defaultPrevented: false,
  immediateStopped: false,
  preventDefault() {
    this.defaultPrevented = true;
  },
  stopImmediatePropagation() {
    this.immediateStopped = true;
  },
};
applyDoc.listeners[0].fn(clickEvent);
check("a claimed click calls preventDefault", clickEvent.defaultPrevented === true);
check("a claimed click calls stopImmediatePropagation, not only stopPropagation", clickEvent.immediateStopped === true);
const launchCall = applyCalls.find((call) => call.method === "POST");
check(
  "a claimed click POSTs the launch route with the absolute path",
  launchCall !== undefined && launchCall.url === "/ui-tweaks/open-in-vscode/launch" &&
    launchCall.init.headers?.["content-type"] === "application/json" &&
    JSON.parse(launchCall.init.body).path === "/abs/clicked.ts",
  JSON.stringify(launchCall),
);
applyCtx.disposers[0]();
check("running the recorded disposer removes the click listener", applyDoc.listeners.length === 0, `${applyDoc.listeners.length} left`);

clickedSandbox.window.fetch = () => Promise.resolve({ ok: true, json: async () => ({ available: false, reason: "disabled" }) });
const noDoc = makeDocument();
const noCtx = makeEffectCtx();
clicked.apply(noCtx, noDoc);
await new Promise((resolve) => setImmediate(resolve));
check("apply installs no listener when the probe says no, so clicks stay dsh's", noDoc.listeners.length === 0, `${noDoc.listeners.length} listener(s)`);
check("apply still owns an effect when the probe says no", noCtx.disposers.length === 1);
let noEffectThrew = false;
try {
  clicked.apply({ get: () => undefined }, makeDocument());
} catch {
  noEffectThrew = true;
}
check("apply without ctx.effect installs nothing instead of throwing", noEffectThrew === false);

// A page that failed to load the sibling script leaves
// `window.__dshDotdshOpenInEditor` undefined; the tweak set must still mount.
let siblingMissingThrew = false;
try {
  const bareDisposers = [];
  const bareCtx = {
    get: () => undefined,
    inject: () => {},
    effect: (callback) => {
      const dispose = callback();
      bareDisposers.push(dispose);
      return dispose;
    },
  };
  exportsObj.apply(bareCtx);
  for (const dispose of bareDisposers) dispose();
} catch {
  siblingMissingThrew = true;
}
check("a missing sibling script (window.__dshDotdshOpenInEditor undefined) does not throw", siblingMissingThrew === false);
//#endregion

console.log(
  failures.length === 0
    ? "\nall checks passed"
    : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
