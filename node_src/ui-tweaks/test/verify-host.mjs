// The committed check for the ui-tweaks node half. Run: pnpm test
//
// This half looks small, but it is one end of a wire contract with no compiler
// across it: the namespace it registers and the field names its schema declares
// are what the browser half (client/index.js, which cannot import from here)
// binds its settings scope to. `tsc` types this half alone, so a rename on one
// side would leave the page silently on its defaults, with no error anywhere.
//
// It loads the BUILT lib/index.js (the `test` script builds first) under a fake
// Host context and asserts the registration call itself — the namespace, the
// `base` layer carrying the row's config, the schema defaults, the serialized
// wire schema, and the no-provider degrade. Built-ins only, no harness, so a
// clean checkout runs it with plain Node.
//
// What a green run does NOT mean: there is no dsh here, so nothing proves that a
// settings provider accepts the name, that the document's user layer resolves
// over `base`, or that a page ever adopts a section. The last region compares
// this half's fields with the browser half's source text, which is a
// name-agreement check rather than a behavioural one — what the page then DOES
// with an adopted section is client/index.js's own check.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The file sits in the package it verifies (test/ one level below the manifest),
// so its package directory comes from its own location: no repo-root guess, and
// nothing breaks if the file moves with the package.
const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(label);
};

const host = await import(pathToFileURL(join(pkgDir, "lib/index.js")).href);

//#region plugin shape
check("exports the cordis plugin name 'ui-tweaks'", host.name === "ui-tweaks", String(host.name));
check("exports a settings namespace", typeof host.SETTINGS_NAMESPACE === "string", String(host.SETTINGS_NAMESPACE));
check(
  "the namespace is inside the settings-name grammar",
  /^[a-z0-9]+(-[a-z0-9]+)*$/.test(host.SETTINGS_NAMESPACE ?? ""),
  String(host.SETTINGS_NAMESPACE),
);
check("exports a schemastery Config", typeof host.Config === "function", typeof host.Config);
check("exports apply", typeof host.apply === "function");
//#endregion

//#region the section this row composes, and the wire schema behind it
const defaults = host.Config({});
check(
  "an empty row config resolves the documented defaults",
  defaults.composerEnterNewline === true && defaults.statusWording === true &&
    Array.isArray(defaults.statusPhrases) && defaults.statusPhrases.length === 0,
  JSON.stringify(defaults),
);
const configured = host.Config({ composerEnterNewline: false, statusPhrases: ["自定义一句"] });
check(
  "the schema resolves a partial row config",
  configured.composerEnterNewline === false && configured.statusWording === true &&
    configured.statusPhrases[0] === "自定义一句",
  JSON.stringify(configured),
);
let rejected = false;
try {
  host.Config({ composerEnterNewline: "yes" });
} catch {
  rejected = true;
}
check("the schema refuses a mistyped field", rejected);
// The descriptor hands this serialization to the page, whose scope rehydrates it
// and validates the resolved section against it: a schema that cannot serialize
// would leave the browser half on its defaults with no error on either side.
let wire = null;
try {
  wire = JSON.stringify(host.Config.toJSON());
} catch {
  wire = null;
}
check("the schema serializes to the wire envelope", typeof wire === "string" && wire.length > 0, String(wire));
check(
  "the wire envelope carries every field",
  wire !== null && [...Object.keys(defaults)].every((field) => wire.includes(`"${field}"`)),
  String(wire),
);
//#endregion

//#region registration against a fake Host settings service
const registrations = [];
const injected = [];
/** A Host context whose optional settings service records what the row registers. */
const makeCtx = (withSettings) => ({
  inject: (deps, callback) => {
    injected.push(deps);
    if (withSettings) callback({ settings: { register: (...args) => registrations.push(args) } });
  },
});

const ctx = makeCtx(true);
const rowConfig = host.Config({ statusWording: false });
host.apply(ctx, rowConfig);
check("waits for the settings service through ctx.inject", JSON.stringify(injected[0]) === JSON.stringify(["settings"]), JSON.stringify(injected));
check("registers exactly one namespace", registrations.length === 1, `${registrations.length} registration(s)`);
check(
  "registers the exported namespace",
  registrations[0]?.[0] === host.SETTINGS_NAMESPACE,
  String(registrations[0]?.[0]),
);
check("registers the exported schema", registrations[0]?.[1] === host.Config);
check(
  "passes the row config as the composition base layer",
  registrations[0]?.[2]?.base === rowConfig,
  JSON.stringify(registrations[0]?.[2]?.base ?? null),
);

// A composition with no settings provider must still mount: the browser half
// then runs on its own defaults, which is why nothing here may throw.
const bareCtx = makeCtx(false);
let degraded = true;
try {
  host.apply(bareCtx, host.Config({}));
} catch (error) {
  degraded = false;
  check("a composition without a settings provider still mounts", false, error.message);
}
check("a composition without a settings provider still mounts", degraded);
check("nothing is registered without a provider", registrations.length === 1);

// A stored section the schema rejects rejects the registration itself, and dsh
// does not surface that anywhere: the row mounts, the page keeps its defaults,
// and a typo in settings.yaml looks like the switches doing nothing. The row
// therefore has to say it — and must still mount.
const warnings = [];
const rejectingCtx = {
  inject: (deps, callback) => {
    callback({
      settings: {
        register: () => {
          throw new Error('invalid section at $.statusPhrases: expected array but got "not-a-list"');
        },
      },
      logger: { warn: (message) => warnings.push(message) },
    });
  },
};
let survived = true;
try {
  host.apply(rejectingCtx, host.Config({}));
} catch (error) {
  survived = false;
  check("a rejected registration does not take the row down", false, error.message);
}
check("a rejected registration does not take the row down", survived);
check("a rejected registration warns with the reason", warnings.length === 1 && warnings[0].includes("expected array"), warnings.join(" | ") || "(no warning)");
check(
  "the warning names the namespace and the fallback",
  warnings.length === 1 && warnings[0].includes(host.SETTINGS_NAMESPACE) && warnings[0].includes("defaults"),
  warnings.join(" | ") || "(no warning)",
);
//#endregion

//#region cross-half name agreement
// The browser half reads a section by field name and binds a namespace by name;
// neither is visible to this half's compiler, so the two source files are the
// only place the agreement can be checked before a page loads them.
const clientSrc = readFileSync(join(pkgDir, "client", "index.js"), "utf8");
const clientNamespace = /const SETTINGS_NAMESPACE = "([^"]+)"/.exec(clientSrc)?.[1];
check(
  "the browser half binds the same namespace",
  clientNamespace === host.SETTINGS_NAMESPACE,
  `${clientNamespace} vs ${host.SETTINGS_NAMESPACE}`,
);
const readFields = new Set([...clientSrc.matchAll(/section\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));
const schemaFields = new Set(Object.keys(defaults));
check(
  "the browser half reads exactly the fields this schema declares",
  readFields.size === schemaFields.size && [...schemaFields].every((field) => readFields.has(field)),
  `reads ${[...readFields].join(", ") || "(none)"} vs ${[...schemaFields].join(", ")}`,
);
//#endregion

console.log(
  failures.length === 0
    ? "\nall checks passed"
    : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
