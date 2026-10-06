// The committed check for the ui-tweaks node half. Run: pnpm test
//
// This half looks small, but it is one end of a wire contract with no compiler
// across it: the entry id its settings form lives under and the field names its
// schema declares are what the browser half (client/index.js, which cannot
// import from here) reads through the settings transport. `tsc` types this half
// alone, so a rename on one side would leave the page silently on its defaults,
// with no error anywhere.
//
// The row's own `Config` schema is the settings form, exposed by the settings
// domain ONLY for fields marked `.volatile()`, and the domain hands `apply` one
// live reference per field. So what this file pins is the exposure rule (every
// field volatile), the entry-id agreement, and the fact that `apply` mounts with
// no settings service in the composition at all.
//
// It loads the BUILT lib/index.js (the `test` script builds first) and checks two
// things:
//   - the schema and the plugin shape: the defaults, the refusal, the serialized
//     wire envelope, the volatile marking on every field, and `apply` mounting
//     with no settings service and registering nothing;
//   - the entry-id/name agreement with the browser half's source text, which no
//     compiler connects.
//
// What a green run does NOT mean: there is no dsh here, so nothing proves that
// the settings domain exposes this entry, that a real user layer resolves over
// the row config, that a page ever adopts a section, or that dsh resolved the
// package. The last region compares this half's fields with the browser half's
// source text, which is a name-agreement check rather than a behavioural one;
// what the page then DOES with an adopted section is client/index.js's own check.
import { existsSync, readFileSync } from "node:fs";
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
check(
  "declares no hard service dependency (the settings form is read off the Loader entry)",
  host.inject === undefined || (Array.isArray(host.inject) && host.inject.length === 0),
  JSON.stringify(host.inject),
);
//#endregion

//#region the section this row composes, and the wire schema behind it
// `Config(raw)` answers what the Loader hands `apply`: one volatile reference per
// field, whose `get()` is the resolved value. The tests below read through it the
// way the plugin does.
const valuesOf = (resolved) =>
  Object.fromEntries(Object.entries(resolved).map(([field, ref]) => [field, ref.get()]));
const defaults = host.Config({});
const defaultValues = valuesOf(defaults);
check(
  "every field is a volatile reference, which is the only reason the settings domain exposes the entry",
  Object.values(defaults).every((ref) => typeof ref?.get === "function"),
  Object.entries(defaults).map(([field, ref]) => `${field}:${typeof ref?.get}`).join(", "),
);
check(
  "the schema marks every field volatile (a plain field would be invisible and uneditable)",
  Object.values(host.Config.dict).every((field) => field.meta?.volatile === true),
  Object.entries(host.Config.dict).map(([field, schema]) => `${field}:${schema.meta?.volatile === true}`).join(", "),
);
check(
  "the schema declares exactly the three page-owned fields",
  Object.keys(defaultValues).length === 3,
  Object.keys(defaultValues).join(", "),
);
check(
  "an empty row config resolves the documented defaults",
  defaultValues.composerEnterNewline === true && defaultValues.statusWording === true &&
    Array.isArray(defaultValues.statusPhrases) && defaultValues.statusPhrases.length === 0,
  JSON.stringify(defaultValues),
);
const configuredValues = valuesOf(host.Config({ composerEnterNewline: false, statusPhrases: ["自定义一句"] }));
check(
  "the schema resolves a partial row config",
  configuredValues.composerEnterNewline === false && configuredValues.statusWording === true &&
    configuredValues.statusPhrases[0] === "自定义一句",
  JSON.stringify(configuredValues),
);
let rejected = false;
try {
  host.Config({ composerEnterNewline: "yes" });
} catch {
  rejected = true;
}
check("the schema refuses a mistyped field", rejected);
// The descriptor hands this serialization to the page, whose transport validates
// the resolved section against it: a schema that cannot serialize would leave the
// browser half on its defaults with no error on either side.
let wire = null;
try {
  wire = JSON.stringify(host.Config.toJSON());
} catch {
  wire = null;
}
check("the schema serializes to the wire envelope", typeof wire === "string" && wire.length > 0, String(wire));
check(
  "the wire envelope carries every field",
  wire !== null && Object.keys(defaultValues).every((field) => wire.includes(`"${field}"`)),
  String(wire),
);
//#endregion

//#region the settings form is the row's own schema, and needs no service
const injected = [];
const routeRegistrations = [];
/**
 * A Host context with NO settings service: the row has to mount anyway, because
 * the form is read off the Loader entry by the settings domain, not registered
 * into it by this plugin.
 */
const makeCtx = () => ({
  inject: (deps, callback) => {
    injected.push(deps);
    // Nothing in the context is consumed: the plugin keeps the settings form
    // alive by existing, so a composition with no service at all still mounts.
  },
  // `apply` is an empty implementation, so the fake effect runs its callback at
  // once (as cordis does) and the fake `webServer` records that nothing is
  // registered.
  effect: (callback) => callback(),
  webServer: {
    register: (spec) => {
      routeRegistrations.push(spec);
      return () => {
        const index = routeRegistrations.indexOf(spec);
        if (index >= 0) routeRegistrations.splice(index, 1);
      };
    },
  },
});

const ctx = makeCtx();
let mounted = true;
try {
  host.apply(ctx, host.Config({ statusWording: false }));
} catch (error) {
  mounted = false;
  check("the row mounts with no settings service in the composition", false, error.message);
}
check("the row mounts with no settings service in the composition", mounted);
check(
  "apply asks for no settings service (the form is the entry's own schema)",
  injected.every((deps) => !deps.includes("settings")),
  JSON.stringify(injected),
);
check(
  "apply registers no routes",
  routeRegistrations.length === 0,
  routeRegistrations.map((spec) => spec.path).join(", "),
);
check(
  "the settings entry id is the plugin name (the Loader row id is the namespace)",
  host.SETTINGS_NAMESPACE === host.name,
  `${host.SETTINGS_NAMESPACE} vs ${host.name}`,
);
// The id is not a free choice: the bundle patch mounts this package under exactly
// that row id, and the settings domain keys the form by it. Checked against the
// sibling patch when this repository is present (a published copy of the package
// has no sibling), because a row renamed without the namespace would silently
// leave the page on the defaults again.
const bundlePatch = join(pkgDir, "..", "dotdsh", "cordis.patch.yml");
if (existsSync(bundlePatch)) {
  const patchText = readFileSync(bundlePatch, "utf8");
  const row = new RegExp(
    `- id: ${host.SETTINGS_NAMESPACE}\\s*\\n\\s*name: '@dsh-external/dotdsh-ui-tweaks'`,
  ).test(patchText);
  check(
    "the bundle patch mounts this package under the id the settings form uses",
    row,
    `row ${host.SETTINGS_NAMESPACE} -> @dsh-external/dotdsh-ui-tweaks`,
  );
}
//#endregion

//#region cross-half name agreement
// The browser half reads a section by field name and binds a namespace by name;
// neither is visible to this half's compiler, so the two source files are the
// only place the agreement can be checked before a page loads them.
//
// Every field of this row is page-owned, so the page's seed and the schema must
// name exactly the same three fields.
const PAGE_OWNED_FIELDS = ["composerEnterNewline", "statusWording", "statusPhrases"];
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
  "the schema is exactly the page-owned fields",
  schemaFields.size === PAGE_OWNED_FIELDS.length && PAGE_OWNED_FIELDS.every((field) => schemaFields.has(field)),
  [...schemaFields].join(", "),
);
check(
  "the browser half reads exactly the fields the page owns",
  readFields.size === PAGE_OWNED_FIELDS.length && PAGE_OWNED_FIELDS.every((field) => readFields.has(field)),
  `reads ${[...readFields].join(", ") || "(none)"} vs ${PAGE_OWNED_FIELDS.join(", ")}`,
);
const seedBody = /const settings = \{([\s\S]*?)\};/.exec(clientSrc)?.[1] ?? "";
const seedFields = [...seedBody.matchAll(/([A-Za-z0-9_]+):/g)].map((match) => match[1]);
check(
  "the page's settings seed mirrors exactly the page-owned fields",
  seedFields.length === PAGE_OWNED_FIELDS.length && PAGE_OWNED_FIELDS.every((field) => seedFields.includes(field)),
  seedFields.join(", ") || "(no seed found)",
);
//#endregion

console.log(
  failures.length === 0
    ? "\nall checks passed"
    : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
