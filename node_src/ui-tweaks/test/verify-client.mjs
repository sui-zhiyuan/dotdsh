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
// `apply(ctx)` with a fake client context (one fake `document` and a fake
// settings form) and asserts the two tweaks' decisions through the listeners
// that activation installs. `node --check` and this file together are what guard
// these bytes.
//
// What a green run does NOT mean: there is no real dsh, no browser, no React, no
// Lexical, no locale service, no settings transport and no network. The
// registration checks prove the boot protocol's shape, not that dsh resolved
// `exports["./client"]`, served this file or added it to the boot graph with a
// `rev`. The Enter checks assert the shape of the synthetic event the tweak
// re-emits, not that Lexical inserted a line break; the wording checks assert
// what the locale wrapper returns, not that the page re-rendered the new text;
// the settings checks publish a section into the fake form directly, so they
// prove what the page does with one, not that dsh resolved, delivered or
// persisted it (that seam is the host half's own check, test/verify-host.mjs).
// Whether either tweak works end to end is settled by loading the page once.
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
// The browser half reads its section through the settings client's `configForms`
// service. Nothing about that module is imported as a value (`require` stays
// empty), but the boot graph needs the edge: `inject` is what makes that row's
// factory arrive — and its service exist — before this one activates.
check(
  "declares the settings client module so configForms exists before this row composes",
  Array.isArray(decl?.inject) && decl.inject.includes("@deepseek-ai/dsh-client-ui-settings"),
  JSON.stringify(decl?.inject),
);
check(
  "requests no external module value (one self-contained script)",
  decl?.external === undefined || decl.external.length === 0,
  JSON.stringify(decl?.external),
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

// The document the module listens on: the classic-script page global the tweaks
// read. `window.document` is the SAME object, so the registration, the page
// global and the listener bookkeeping all describe one page.
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
  },
  document: documentRef,
  console: {
    error: () => {},
    log: () => {},
    warn: () => {},
  },
  KeyboardEvent: class KeyboardEvent {
    constructor(type, init = {}) {
      Object.assign(this, init);
      this.type = type;
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
// The status line has TWO shipped templates, and this tweak's whole job is to sit
// between them: `chat.deepDiving` is the bare wording (also the copy the
// visually-hidden live region carries) and `chat.deepDivingFor` appends the
// elapsed time. Modelling both is what makes the regression that broke this tweak
// visible — dsh 0.2.0-rc.2 moved the VISIBLE label to the longer key, and a check
// that only asked the bare one stayed green while the line on screen was dsh's.
const SHIPPED_STATUS = "深度求索中";
const shippedStatusFor = (duration) => `${SHIPPED_STATUS}，用时 ${duration} ···`;
FakeLocale.prototype.translate = function translate(ns, key, params) {
  if (ns === "chat" && key === "chat.deepDiving") return SHIPPED_STATUS;
  if (ns === "chat" && key === "chat.deepDivingFor") return shippedStatusFor(params?.duration ?? "");
  return shipped(ns, key);
};
const locale = new FakeLocale();
const statusLine = () => locale.translate("chat", "chat.deepDiving");
const statusLabel = () => locale.translate("chat", "chat.deepDivingFor", { duration: "1 秒" });

// The settings transport is an OPTIONAL cordis dependency, so the fake context
// implements `inject(deps, callback)` beside `get`, and the form stands in for
// the per-entry view `configForms.get(entryId)` answers: `value` is the resolved
// section the Host would publish, and the listeners are what a committed change
// notifies.
const formState = { value: undefined, listeners: [] };
let formReleased = false;
const requestedEntryIds = [];
const injectedDeps = [];
const effectLabels = [];
const fakeForm = {
  getSnapshot: () => ({
    status: formState.value === undefined ? "unavailable" : "ready",
    value: formState.value,
    base: undefined,
    user: undefined,
    revision: 1,
    writable: false,
    mode: "memory",
  }),
  subscribe: (listener) => {
    formState.listeners.push(listener);
    return () => {
      formState.listeners = formState.listeners.filter((entry) => entry !== listener);
      formReleased = true;
    };
  },
  set: () => Promise.resolve(),
  unset: () => Promise.resolve(),
  mutate: () => Promise.resolve(),
};
const configForms = {
  get: (entryId) => {
    requestedEntryIds.push(entryId);
    return fakeForm;
  },
};
/** Publish one accepted section the way the transport does: replace, then notify. */
const adopt = (value) => {
  formState.value = value;
  for (const listener of [...formState.listeners]) listener();
};

/**
 * The fake client context `apply` is driven with. `services` is what `ctx.get`
 * answers: the one `locale` service the tweaks need. `inject` hands the optional
 * settings transport to its callback, and `effect` records every disposer so
 * teardown can be exercised.
 */
const makeCtx = () => {
  const disposers = [];
  const services = { locale };
  const ctx = {
    get: (name) => services[name],
    inject: (deps, callback) => {
      injectedDeps.push(deps);
      callback({ get: ctx.get, effect: ctx.effect, configForms });
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

const listenerOn = (doc, type, capture) =>
  doc.listeners.filter((entry) => entry.type === type && entry.capture === capture);

const main = makeCtx();
if (typeof exportsObj?.apply === "function") exportsObj.apply(main.ctx);

const keydownListeners = listenerOn(documentRef, "keydown", true);
check(
  "the module's own apply installs exactly one capture-phase keydown listener",
  keydownListeners.length === 1,
  `${keydownListeners.length} listener(s)`,
);
check(
  "the module's own apply installs no click listener",
  listenerOn(documentRef, "click", true).length === 0,
  `${listenerOn(documentRef, "click", true).length} listener(s)`,
);
check(
  "the listener lands on the page global the module and the sandbox share",
  documentRef === sandbox.window.document && documentRef === sandbox.document,
);
check(
  "every ctx.effect call carries a label",
  effectLabels.length > 0 &&
    effectLabels.every((label) => typeof label === "string" && label !== ""),
  JSON.stringify(effectLabels),
);

check("asks the settings transport for exactly one entry", requestedEntryIds.length === 1, `${requestedEntryIds.length} request(s)`);
check("asks for the ui-tweaks entry id", requestedEntryIds[0] === "ui-tweaks", String(requestedEntryIds[0]));
check("reaches settings through ctx.inject, not a hard dependency", JSON.stringify(injectedDeps) === JSON.stringify([["configForms"]]), JSON.stringify(injectedDeps));
check("configForms is not a hard inject dependency", !exportsObj.inject.includes("configForms"), JSON.stringify(exportsObj.inject));
check("subscribes to the entry's form", formState.listeners.length === 1, `${formState.listeners.length} listener(s)`);
//#endregion

//#region status wording tweak (through the one locale service)
const first = statusLine();
check("the running-turn line is reworded in a Chinese UI", typeof first === "string" && first.length > 0 && first !== SHIPPED_STATUS, first);
// No section has been published yet: the reworded line above, and the Enter
// interception the region below asserts, are the schema defaults at work.
check("no accepted section yet, so the tweak set is on its schema defaults", formState.value === undefined, String(formState.value));
check("other chat copy passes through untouched", locale.translate("chat", "chat.loadOlder") === shipped("chat", "chat.loadOlder"));
check("other namespaces pass through untouched", locale.translate("common", "chat.deepDiving") === shipped("common", "chat.deepDiving"));
check("the wording is stable within one run", statusLine() === first, `${statusLine()} vs ${first}`);
// The line the user actually reads is the ELAPSED-TIME variant, and dsh moved it
// to its own key. Both seats must carry the same drawn wording, with everything
// the shipped template appends — the timer, its punctuation — kept verbatim.
check(
  "the visible elapsed-time line is reworded too",
  statusLabel() !== shippedStatusFor("1 秒") && statusLabel().startsWith(first),
  `${statusLabel()} vs ${shippedStatusFor("1 秒")}`,
);
check(
  "the visible line keeps dsh's elapsed time after the drawn wording",
  statusLabel().endsWith("，用时 1 秒 ···") && statusLabel() === `${first}，用时 1 秒 ···`,
  statusLabel(),
);
check(
  "both status seats are answered with the same phrase in one render",
  statusLine() === first && statusLabel().startsWith(first),
  `${statusLine()} / ${statusLabel()}`,
);
fakeNow += 3_000;
randoms.push(0);
const second = statusLine();
check("a new run draws again", second !== SHIPPED_STATUS && second.length > 0, second);
check("a new run does not repeat the previous wording", second !== first, `${second} vs ${first}`);
localeState.active = "en";
check("an English UI keeps the shipped wording", statusLine() === SHIPPED_STATUS, statusLine());
check("an English UI keeps the shipped elapsed-time line", statusLabel() === shippedStatusFor("1 秒"), statusLabel());
localeState.active = "zh-CN";
fakeNow += 3_000;
randoms.push(0);
check("a regional Chinese locale is still reworded", statusLine() !== SHIPPED_STATUS);
check("a regional Chinese locale rewords the visible line too", statusLabel() !== shippedStatusFor("1 秒"), statusLabel());
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

//#region settings-driven behaviour (the ui-tweaks settings form)
// The section shape is the one the node half's schema declares, and the host
// check pins that the two halves name the same fields. What is checked here is
// what the PAGE does with an adopted section: an edit arrives through the form
// subscription alone — no re-install, no reload — and each field switches only
// its own tweak.
adopt({ composerEnterNewline: false, statusWording: true, statusPhrases: [] });
check("composerEnterNewline: false leaves bare Enter to the shipped keymap", run(keydown({ target: makeComposer(true) })).intercepted === false);
check("composerEnterNewline: false still lets Ctrl+Enter through", run(keydown({ ctrlKey: true, target: makeComposer(true) })).intercepted === false);

adopt({ composerEnterNewline: true, statusWording: false, statusPhrases: [] });
check("statusWording: false restores the shipped running-turn copy", statusLine() === SHIPPED_STATUS, statusLine());
check(
  "statusWording: false restores the shipped elapsed-time line too",
  statusLabel() === shippedStatusFor("1 秒"),
  statusLabel(),
);
check("statusWording: false leaves other chat copy alone", locale.translate("chat", "chat.loadOlder") === shipped("chat", "chat.loadOlder"));
check("composerEnterNewline: true comes back without a re-install", run(keydown({ target: makeComposer(true) })).intercepted);
check("the page still carries one keydown listener", listenerOn(documentRef, "keydown", true).length === 1, `${listenerOn(documentRef, "keydown", true).length} left`);
check("a settings edit installs no extra document listener", listenerOn(documentRef, "click", true).length === 0, `${listenerOn(documentRef, "click", true).length} left`);

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
  shippedDraw !== "自定义乙" && shippedDraw !== SHIPPED_STATUS && shippedDraw.length > 0,
  shippedDraw,
);

// Blank and non-string entries are the shape a hand-edited user layer really
// produces; they must not enter the bank (a blank status line would read as a
// broken page) and must not disable the tweak.
adopt({ composerEnterNewline: true, statusWording: true, statusPhrases: ["", "   ", 42, null, "有效的一句"] });
fakeNow += 3_000;
randoms.push(0.999999);
check("blank and non-string entries never reach the bank", statusLine() === "有效的一句", statusLine());

// A section the page cannot read (an unanswered read, a hand-edit the schema
// rejected, an entry the Host stopped serving) keeps the last accepted values.
adopt(undefined);
check("an absent section keeps the Enter tweak on", run(keydown({ target: makeComposer(true) })).intercepted);
check("an absent section keeps the wording tweak on", statusLine() !== SHIPPED_STATUS, statusLine());
check("an absent section keeps the visible line reworded", statusLabel() !== shippedStatusFor("1 秒"), statusLabel());
adopt("not a section");
check("a malformed section keeps the adopted values", run(keydown({ target: makeComposer(true) })).intercepted);
//#endregion

//#region teardown of the one activation
for (const dispose of main.disposers) dispose();
check("disposing removes the document keydown listener", listenerOn(documentRef, "keydown", true).length === 0, `${listenerOn(documentRef, "keydown", true).length} left`);
check("disposing leaves no other document listener", listenerOn(documentRef, "click", true).length === 0, `${listenerOn(documentRef, "click", true).length} left`);
check("disposing releases the settings subscription", formReleased && formState.listeners.length === 0, `${formState.listeners.length} left`);
check(
  "disposing restores the shipped wording",
  statusLine() === SHIPPED_STATUS && statusLabel() === shippedStatusFor("1 秒") &&
    !Object.prototype.hasOwnProperty.call(locale, "translate"),
  `${statusLine()} / ${statusLabel()}`,
);
//#endregion

console.log(
  failures.length === 0
    ? "\nall checks passed"
    : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
