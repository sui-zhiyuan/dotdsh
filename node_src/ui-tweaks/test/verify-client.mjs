// The committed check for the ui-tweaks browser half. Run: pnpm test
//
// `client/index.js` is the one file in this repository with no compiler behind it:
// `tsc` only builds `src/`, and dsh serves those exact bytes to the page, failing
// the boot when the file is missing. This script is that file's gate. It mirrors
// what dsh's client-modules scanner reads out of the package manifest, loads the
// browser half in a `node:vm` sandbox under a fake `window.__ModuleLoader__`, and
// asserts every decision both tweaks make against a fake DOM and a fake locale
// service. Built-ins only (`node:vm|fs|path|url`), so a clean checkout runs it
// with plain Node — no test framework, no dependency, no harness, no network.
//
// What a green run does NOT mean: there is no React, no Lexical and no locale
// service in here. The Enter checks assert the shape of the synthetic event the
// tweak re-emits, not that Lexical inserted a line break; the wording checks
// assert what the locale wrapper returns, not that the page re-rendered the new
// text. Whether either tweak works end to end is settled by loading the page once.
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
const disposers = [];
const ctx = {
  get: (name) => (name === "locale" ? locale : undefined),
  effect: (callback, label) => {
    check("ctx.effect label is set", typeof label === "string", String(label));
    const dispose = callback();
    disposers.push(dispose);
    return dispose;
  },
};
exportsObj.apply(ctx);

const first = statusLine();
check("the running-turn line is reworded in a Chinese UI", typeof first === "string" && first.length > 0 && first !== shipped("chat", "chat.deepDiving"), first);
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

//#region teardown
for (const dispose of disposers) dispose();
check("disposing removes the document listener", listeners.length === 0, `${listeners.length} left`);
check(
  "disposing restores the shipped wording",
  statusLine() === shipped("chat", "chat.deepDiving") && !Object.prototype.hasOwnProperty.call(locale, "translate"),
  statusLine(),
);
//#endregion

console.log(
  failures.length === 0
    ? "\nall checks passed"
    : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
