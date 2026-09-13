// The committed check for the ui-tweaks node half. Run: pnpm test
//
// This half looks small, but it is one end of a wire contract with no compiler
// across it: the namespace it registers and the field names its schema declares
// are what the browser half (client/index.js, which cannot import from here)
// binds its settings scope to. `tsc` types this half alone, so a rename on one
// side would leave the page silently on its defaults, with no error anywhere.
//
// It loads the BUILT lib/*.js (the `test` script builds first) and checks three
// things:
//   - the registration call itself, under a fake Host context: the namespace,
//     the `base` layer carrying the row's config, the schema defaults, the
//     serialized wire schema, the no-provider degrade and the rejected-
//     registration warning;
//   - the launcher (`editor-launch.ts`) against REAL resources: a scratch
//     directory tree and a real executable script that records its own argv, so
//     the resolve/contain/spawn decisions are exercised with the filesystem and
//     child_process that actually run, not mocks;
//   - the two routes (`open-in-vscode.ts`) as plain handlers under a fake
//     `webServer` (capturing registrations), a fake `connection` (whose
//     rejection is controlled) and fake request/response objects.
//
// What a green run does NOT mean: there is no dsh here, so nothing proves that a
// settings provider accepts the name, that the document's user layer resolves
// over `base`, that a page ever adopts a section, or that dsh's real web server
// dispatches to these handlers. The last region compares this half's fields with
// the browser half's source text, which is a name-agreement check rather than a
// behavioural one; what the page then DOES with an adopted section is
// client/index.js's own check. "disabled never probes PATH" is asserted by the
// answer's ordering (a command that cannot resolve still reports `disabled`,
// never `not-installed`), not by observing the `stat` — this script has no way
// to instrument the host's PATH lookup without replacing the filesystem.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
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
// The built leaves are loaded directly: `index.ts` exports their topic types but
// not their values, and both are the subject of their own regions below.
const launcher = await import(pathToFileURL(join(pkgDir, "lib/editor-launch.js")).href);
const routesApi = await import(pathToFileURL(join(pkgDir, "lib/open-in-vscode.js")).href);

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
  "declares the route carrier and the trust fence as hard dependencies",
  JSON.stringify(host.inject) === JSON.stringify(["webServer", "connection"]),
  JSON.stringify(host.inject),
);
//#endregion

//#region the section this row composes, and the wire schema behind it
const defaults = host.Config({});
check(
  "an empty row config resolves the documented defaults",
  defaults.composerEnterNewline === true && defaults.statusWording === true &&
    Array.isArray(defaults.statusPhrases) && defaults.statusPhrases.length === 0 &&
    defaults.openInVscode === true && defaults.editorCommand === "code",
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
const routeRegistrations = [];
/** A Host context whose optional settings service records what the row registers. */
const makeCtx = (withSettings) => ({
  inject: (deps, callback) => {
    injected.push(deps);
    if (withSettings) callback({ settings: { register: (...args) => registrations.push(args) } });
  },
  // `apply` now also registers the two routes through `ctx.effect`, whose
  // callback builds them from `ctx.webServer`; the fake effect runs it at once
  // and keeps the returned disposer, exactly as cordis does.
  effect: (callback) => callback(),
  get: () => undefined,
  sessions: { get: () => undefined },
  connection: { requestRejection: () => undefined },
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
check(
  "apply also registers both open-in-editor routes under ctx.effect",
  routeRegistrations.length === 2 &&
    routeRegistrations.every((spec) => spec.kind === "exact") &&
    routeRegistrations.some((spec) => spec.path === routesApi.OPEN_IN_EDITOR_STATUS_ROUTE) &&
    routeRegistrations.some((spec) => spec.path === routesApi.OPEN_IN_EDITOR_LAUNCH_ROUTE),
  routeRegistrations.map((spec) => `${spec.kind} ${spec.path}`).join(", "),
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
  effect: (callback) => callback(),
  get: () => undefined,
  sessions: { get: () => undefined },
  connection: { requestRejection: () => undefined },
  webServer: { register: () => () => {} },
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
//
// The schema has five fields, but only three are PAGE-owned: `openInVscode` and
// `editorCommand` are enforced by the host routes (the only side that can act on
// them), so the page deliberately reads neither and cannot disagree with the
// authority. This region pins that split rather than "the page reads every
// field", which stopped being true when the editor fields joined the schema.
const PAGE_OWNED_FIELDS = ["composerEnterNewline", "statusWording", "statusPhrases"];
const HOST_ENFORCED_FIELDS = ["openInVscode", "editorCommand"];
const clientSrc = readFileSync(join(pkgDir, "client", "index.js"), "utf8");
// The open-in-editor handler is no longer a sibling script: dsh exposes ONE route
// for a package's browser code, so a second file could never be loaded and now lives
// inside client/index.js. Both the namespace read and the route constants therefore
// come from that one file.
const clientNamespace = /const SETTINGS_NAMESPACE = "([^"]+)"/.exec(clientSrc)?.[1];
check(
  "the browser half binds the same namespace",
  clientNamespace === host.SETTINGS_NAMESPACE,
  `${clientNamespace} vs ${host.SETTINGS_NAMESPACE}`,
);
const readFields = new Set([...clientSrc.matchAll(/section\.([A-Za-z0-9_]+)/g)].map((match) => match[1]));
const schemaFields = new Set(Object.keys(defaults));
check(
  "the schema is exactly the page-owned fields plus the host-enforced ones",
  schemaFields.size === PAGE_OWNED_FIELDS.length + HOST_ENFORCED_FIELDS.length &&
    [...PAGE_OWNED_FIELDS, ...HOST_ENFORCED_FIELDS].every((field) => schemaFields.has(field)),
  [...schemaFields].join(", "),
);
check(
  "the browser half reads exactly the fields the page owns",
  readFields.size === PAGE_OWNED_FIELDS.length && PAGE_OWNED_FIELDS.every((field) => readFields.has(field)),
  `reads ${[...readFields].join(", ") || "(none)"} vs ${PAGE_OWNED_FIELDS.join(", ")}`,
);
check(
  "the browser half reads none of the host-enforced fields",
  HOST_ENFORCED_FIELDS.every((field) => !readFields.has(field)) && !/settings\.(openInVscode|editorCommand)\b/.test(clientSrc),
  `reads ${[...readFields].join(", ") || "(none)"}`,
);
const seedBody = /const settings = \{([\s\S]*?)\};/.exec(clientSrc)?.[1] ?? "";
const seedFields = [...seedBody.matchAll(/([A-Za-z0-9_]+):/g)].map((match) => match[1]);
check(
  "the page's settings seed mirrors exactly the page-owned fields",
  seedFields.length === PAGE_OWNED_FIELDS.length && PAGE_OWNED_FIELDS.every((field) => seedFields.includes(field)),
  seedFields.join(", ") || "(no seed found)",
);
// The two route constants must be identical on both sides of the wire too: the
// host registers the path and the page calls it, with no compiler between them.
const clientStatusRoute = /const STATUS_ROUTE = "([^"]+)"/.exec(clientSrc)?.[1];
const clientLaunchRoute = /const LAUNCH_ROUTE = "([^"]+)"/.exec(clientSrc)?.[1];
check(
  "the browser half calls the host's status route",
  clientStatusRoute === routesApi.OPEN_IN_EDITOR_STATUS_ROUTE,
  `${clientStatusRoute} vs ${routesApi.OPEN_IN_EDITOR_STATUS_ROUTE}`,
);
check(
  "the browser half calls the host's launch route",
  clientLaunchRoute === routesApi.OPEN_IN_EDITOR_LAUNCH_ROUTE,
  `${clientLaunchRoute} vs ${routesApi.OPEN_IN_EDITOR_LAUNCH_ROUTE}`,
);
//#endregion

//#region real scratch resources
// The launcher region below is deliberately built on a real tree and a real
// executable: the resolve/contain/spawn decisions are about the filesystem and
// child_process, so a mock would only re-state the implementation.
const scratch = mkdtempSync(join(tmpdir(), "ui-tweaks-verify-"));
const cleanups = [scratch];
const wsRoot = join(scratch, "ws");
mkdirSync(join(wsRoot, "sub"), { recursive: true });
writeFileSync(join(wsRoot, "sub", "a.txt"), "a\n", "utf8");
writeFileSync(join(wsRoot, "inside.txt"), "inside\n", "utf8");
const outsideFile = join(scratch, "outside.txt");
writeFileSync(outsideFile, "outside\n", "utf8");
const insideReal = realpathSync(join(wsRoot, "inside.txt"));
const nestedReal = realpathSync(join(wsRoot, "sub", "a.txt"));
let symlinkMade = false;
try {
  symlinkSync(outsideFile, join(wsRoot, "link-out"));
  symlinkMade = true;
} catch {
  symlinkMade = false;
}

function writeExecutable(dir, name, body) {
  const file = join(dir, name);
  writeFileSync(file, body, "utf8");
  chmodSync(file, 0o755);
  return file;
}

// The argv recorder is a REAL process: its script writes its own $0 and $@ to a
// file, so the check reads what the kernel actually handed it rather than what
// the launcher says it passed.
const recordPath = join(scratch, "spawn-argv.txt");
const successEditor = writeExecutable(scratch, "fake-editor", [
  "#!/bin/sh",
  "{",
  `  printf 'argv0=%s\\n' "$0"`,
  `  for a in "$@"; do printf 'arg=%s\\n' "$a"; done`,
  `} > "${recordPath}"`,
  "exit 0",
  "",
].join("\n"));
const failingEditor = writeExecutable(scratch, "failing-editor", "#!/bin/sh\nexit 3\n");
const spacedEditor = writeExecutable(scratch, "editor with space", "#!/bin/sh\nexit 0\n");
const binDir = join(scratch, "bin");
mkdirSync(binDir, { recursive: true });
const probeEditor = writeExecutable(binDir, "ui-tweaks-probe-editor", "#!/bin/sh\nexit 0\n");

const resetRecord = () => rmSync(recordPath, { force: true });
const recorded = () => {
  if (!existsSync(recordPath)) return null;
  const lines = readFileSync(recordPath, "utf8").split("\n").filter((line) => line !== "");
  return {
    argv0: lines.find((line) => line.startsWith("argv0="))?.slice("argv0=".length),
    args: lines.filter((line) => line.startsWith("arg=")).map((line) => line.slice("arg=".length)),
  };
};

const launchConfig = (overrides = {}) => ({ openInVscode: true, editorCommand: successEditor, ...overrides });
const missingEditor = `ui-tweaks-missing-editor-${process.pid}`;
const preAbortedSignal = { aborted: true, addEventListener() {}, removeEventListener() {} };

// Run a promise against a deadline so "settles rather than hanging" is asserted
// as a property of the call, not merely of this script having finished.
const withDeadline = (promise, ms = 1500) =>
  Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("TIMEOUT"), ms))]);
//#endregion

//#region editor launcher: the resolve/contain/spawn contract
// 1. The switch answers before any filesystem or process work.
resetRecord();
const off = await launcher.launchInEditor(wsRoot, "inside.txt", undefined, launchConfig({ openInVscode: false }));
check("openInVscode: false fails with disabled", off.ok === false && off.reason === "disabled", JSON.stringify(off));
const offOutside = await launcher.launchInEditor(wsRoot, outsideFile, undefined, launchConfig({ openInVscode: false }));
check(
  "disabled short-circuits the containment check (an outside target is still disabled)",
  offOutside.ok === false && offOutside.reason === "disabled",
  JSON.stringify(offOutside),
);
const offRootless = await launcher.launchInEditor(undefined, "definitely-missing.txt", undefined, launchConfig({ openInVscode: false }));
check(
  "disabled short-circuits path resolution (a rootless relative path is still disabled)",
  offRootless.ok === false && offRootless.reason === "disabled",
  JSON.stringify(offRootless),
);
check("disabled spawns nothing", recorded() === null);

// 2. A relative path with no workspace root is never guessed against the host
//    process's own cwd: the probe file really exists there, so a cwd-based
//    resolution would have reached the editor and left a record.
const cwdProbeName = `.ui-tweaks-cwd-probe-${process.pid}-${Date.now()}.txt`;
const cwdProbe = join(process.cwd(), cwdProbeName);
writeFileSync(cwdProbe, "probe\n", "utf8");
cleanups.push(cwdProbe);
resetRecord();
const rootless = await launcher.launchInEditor(undefined, cwdProbeName, undefined, launchConfig());
check(
  "a relative path with no workspace root is unresolvable",
  rootless.ok === false && rootless.reason === "unresolvable",
  JSON.stringify(rootless),
);
check("a rootless relative path is never resolved against the process cwd (nothing was spawned)", recorded() === null);

// 3. A relative path resolves against the workspace root.
resetRecord();
const relative = await launcher.launchInEditor(wsRoot, "sub/a.txt", undefined, launchConfig());
check(
  "a relative path resolves against the workspace root",
  relative.ok === true && relative.file === nestedReal,
  JSON.stringify(relative),
);
check(
  "a resolved relative path spawns the editor with the resolved file",
  JSON.stringify(recorded()?.args) === JSON.stringify([nestedReal]),
  JSON.stringify(recorded()),
);

// 4. A missing target and a directory both fail with unresolvable.
const missing = await launcher.launchInEditor(wsRoot, "nope.txt", undefined, launchConfig());
check("a missing path is unresolvable", missing.ok === false && missing.reason === "unresolvable", JSON.stringify(missing));
const directory = await launcher.launchInEditor(wsRoot, "sub", undefined, launchConfig());
check("a directory is unresolvable", directory.ok === false && directory.reason === "unresolvable", JSON.stringify(directory));

// 5. A target outside the workspace root fails with outside-workspace: a `../`
//    escape, an absolute outside path, and a symlink inside the root that points
//    out of it (resolve-then-contain follows the link).
resetRecord();
const escaped = await launcher.launchInEditor(wsRoot, "../outside.txt", undefined, launchConfig());
check("a ../ escape is outside-workspace", escaped.ok === false && escaped.reason === "outside-workspace", JSON.stringify(escaped));
const absoluteOutside = await launcher.launchInEditor(wsRoot, outsideFile, undefined, launchConfig());
check("an absolute outside path is outside-workspace", absoluteOutside.ok === false && absoluteOutside.reason === "outside-workspace", JSON.stringify(absoluteOutside));
if (symlinkMade) {
  const viaSymlink = await launcher.launchInEditor(wsRoot, "link-out", undefined, launchConfig());
  check(
    "a symlink inside the root pointing out of it is outside-workspace",
    viaSymlink.ok === false && viaSymlink.reason === "outside-workspace",
    JSON.stringify(viaSymlink),
  );
} else {
  check("a symlink inside the root pointing out of it is outside-workspace", true, "skipped: symlink unavailable in this environment");
}
check("an outside-workspace target spawns nothing", recorded() === null);

// 6. A workspace-relative target that is legitimately inside succeeds.
resetRecord();
const inside = await launcher.launchInEditor(wsRoot, "inside.txt", undefined, launchConfig());
check("a workspace-relative target inside the root succeeds", inside.ok === true && inside.file === insideReal, JSON.stringify(inside));

// 7. A command that does not resolve is not-installed.
resetRecord();
const notInstalled = await launcher.launchInEditor(wsRoot, "inside.txt", undefined, launchConfig({ editorCommand: missingEditor }));
check("an editor command that does not resolve is not-installed", notInstalled.ok === false && notInstalled.reason === "not-installed", JSON.stringify(notInstalled));
check("not-installed spawns nothing", recorded() === null);

// 8. The spawned argv is exactly [executable, file], or [executable, --goto,
//    file:line] with a valid line. `argv0` proves the recorder itself was the
//    spawned program; the recorded args are the child's own $@.
resetRecord();
await launcher.launchInEditor(wsRoot, "inside.txt", undefined, launchConfig());
check(
  "without a line the spawned argv is exactly [executable, file]",
  recorded()?.argv0 === successEditor && JSON.stringify(recorded()?.args) === JSON.stringify([insideReal]),
  JSON.stringify(recorded()),
);
resetRecord();
const atLine = await launcher.launchInEditor(wsRoot, "inside.txt", 42, launchConfig());
check(
  "with a line the spawned argv is exactly [executable, --goto, file:line]",
  atLine.ok === true && recorded()?.argv0 === successEditor && JSON.stringify(recorded()?.args) === JSON.stringify(["--goto", `${insideReal}:42`]),
  JSON.stringify(recorded()),
);
for (const badLine of [0, -3, 1.5, "7", Number.NaN]) {
  resetRecord();
  const ignored = await launcher.launchInEditor(wsRoot, "inside.txt", badLine, launchConfig());
  check(
    `a line that is not a positive integer (${String(badLine)}) is ignored and the file opens bare`,
    ignored.ok === true && JSON.stringify(recorded()?.args) === JSON.stringify([insideReal]),
    JSON.stringify(recorded()),
  );
}

// 9. resolveEditorCommand: bare name on PATH, absolute existing file, and the
//    negative answers — including a command with whitespace, which must never be
//    truncated to the executable its first token names.
const savedPath = process.env.PATH;
process.env.PATH = `${binDir}${delimiter}${savedPath ?? ""}`;
try {
  const onPath = await launcher.resolveEditorCommand("ui-tweaks-probe-editor");
  check("a bare name resolves on PATH", onPath === probeEditor, String(onPath));
} finally {
  if (typeof savedPath === "string") process.env.PATH = savedPath;
}
check("an absolute existing file resolves", (await launcher.resolveEditorCommand(successEditor)) === successEditor);
check("a missing bare name does not resolve", (await launcher.resolveEditorCommand(missingEditor)) === undefined);
check(
  "an absolute missing path does not resolve",
  (await launcher.resolveEditorCommand(join(scratch, "nope-editor"))) === undefined,
);
check(
  "a command with whitespace never resolves to a truncated path",
  (await launcher.resolveEditorCommand(`${successEditor} --wait`)) === undefined,
);
check(
  "an absolute path that really contains a space does not resolve",
  (await launcher.resolveEditorCommand(spacedEditor)) === undefined,
);
check(
  "a relative path is not treated as a bare PATH name",
  (await launcher.resolveEditorCommand("./fake-editor")) === undefined,
);

// 10. A pre-aborted signal settles instead of hanging, and settles before any
//     filesystem or process work.
resetRecord();
const abortedLaunch = await withDeadline(launcher.launchInEditor(wsRoot, "inside.txt", undefined, launchConfig(), preAbortedSignal));
check(
  "a pre-aborted signal settles the launch instead of hanging",
  abortedLaunch !== "TIMEOUT" && abortedLaunch.ok === false && abortedLaunch.reason === "launch-failed",
  JSON.stringify(abortedLaunch),
);
check("an aborted launch spawns nothing", recorded() === null);
const abortedLookup = await withDeadline(launcher.resolveEditorCommand(successEditor, preAbortedSignal));
check("a pre-aborted signal settles the command lookup", abortedLookup === undefined, String(abortedLookup));
//#endregion

//#region open-in-editor routes against a fake web server, fence and HTTP objects
const STATUS_ROUTE = routesApi.OPEN_IN_EDITOR_STATUS_ROUTE;
const LAUNCH_ROUTE = routesApi.OPEN_IN_EDITOR_LAUNCH_ROUTE;

/** A request is an async iterable of body chunks plus method/headers/url. */
function makeRequest({ method = "GET", headers = {}, body = undefined, url = "/" } = {}) {
  const chunks = [];
  if (body !== undefined && body !== null) {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body), "utf8");
    for (let offset = 0; offset < buffer.length; offset += 4096) chunks.push(buffer.subarray(offset, offset + 4096));
  }
  return {
    method,
    headers,
    url,
    resumed: false,
    resume() {
      this.resumed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

/** A response records its status, headers and the body handed to `end`. */
function makeResponse() {
  return {
    statusCode: undefined,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    end(chunk) {
      this.ended = true;
      this.body = chunk;
    },
  };
}

const routeConfig = (overrides = {}) => ({
  composerEnterNewline: true,
  statusWording: true,
  statusPhrases: [],
  openInVscode: true,
  editorCommand: successEditor,
  ...overrides,
});

function routeFixture({ config, settings, sessions, rejection } = {}) {
  const registered = [];
  const webServer = {
    register(spec) {
      registered.push(spec);
      return () => {
        const index = registered.indexOf(spec);
        if (index >= 0) registered.splice(index, 1);
      };
    },
  };
  const connection = {
    calls: [],
    requestRejection(req) {
      this.calls.push(req);
      return rejection;
    },
  };
  // `inject` is REQUIRED by the fixture, not optional sugar: within a real
  // cordis plugin fiber an UNDECLARED service access throws
  // (`cannot get property "sessions" without inject`), which is how the launch
  // route once failed every request with an empty 400 while the availability
  // probe stayed green. Modelling `inject` here is what lets this check see that
  // class of mistake at all.
  const store = sessions ?? { get: () => undefined };
  const ctx = {
    webServer,
    connection,
    get: (name) => (name === "settings" ? settings : undefined),
    effect: (callback) => callback(),
    inject: (deps, callback) => {
      if (deps.includes("sessions")) callback({ sessions: store });
    },
  };
  const dispose = routesApi.openInEditorRoutes(ctx, config);
  const handlerOf = (path) => registered.find((route) => route.path === path)?.handler;
  return { registered, connection, dispose, statusHandler: handlerOf(STATUS_ROUTE), launchHandler: handlerOf(LAUNCH_ROUTE) };
}

const callLaunch = async (fixture, body) => {
  const res = makeResponse();
  await fixture.launchHandler(makeRequest({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), res);
  return res;
};
const checkNoStore = (label, res) => {
  check(`${label} is answered no-store`, res.ended === true && res.headers["cache-control"] === "no-store", `${res.statusCode} ${JSON.stringify(res.headers)}`);
};

// 11. Both routes registered at the documented paths and kinds; one disposer
//     removes both.
const registeredFixture = routeFixture({ config: routeConfig() });
check(
  "registers both routes as exact matches",
  registeredFixture.registered.length === 2 && registeredFixture.registered.every((route) => route.kind === "exact"),
  registeredFixture.registered.map((route) => `${route.kind} ${route.path}`).join(", "),
);
check("the status route path is the documented constant", STATUS_ROUTE === "/ui-tweaks/open-in-vscode/status", STATUS_ROUTE);
check("the launch route path is the documented constant", LAUNCH_ROUTE === "/ui-tweaks/open-in-vscode/launch", LAUNCH_ROUTE);
check("both registered handlers are functions", typeof registeredFixture.statusHandler === "function" && typeof registeredFixture.launchHandler === "function");
registeredFixture.dispose();
check("the returned disposer removes both routes", registeredFixture.registered.length === 0, `${registeredFixture.registered.length} left`);

// 12. A requestRejection answer is honoured and nothing else happens.
const rejectedFixture = routeFixture({ config: routeConfig(), rejection: 403 });
const rejectedRes = makeResponse();
await rejectedFixture.statusHandler(makeRequest({ method: "GET" }), rejectedRes);
check(
  "a requestRejection answer is honoured",
  rejectedRes.statusCode === 403 && rejectedRes.ended === true,
  `${rejectedRes.statusCode} ended=${rejectedRes.ended}`,
);
check(
  "a rejected request answers nothing else",
  rejectedRes.body === undefined && rejectedRes.headers["content-type"] === undefined,
  JSON.stringify(rejectedRes.headers),
);
check("the fence is asked before anything else", rejectedFixture.connection.calls.length === 1, `${rejectedFixture.connection.calls.length} call(s)`);

// 13. Transport failures: wrong method, non-JSON content-type, oversized body,
//     malformed body. The launch ceiling is the documented 64 KiB.
const transportFixture = routeFixture({ config: routeConfig({ editorCommand: missingEditor }) });
const status405 = makeResponse();
await transportFixture.statusHandler(makeRequest({ method: "POST" }), status405);
check("a wrong method on the status route is 405 with allow", status405.statusCode === 405 && status405.headers.allow === "GET" && status405.ended === true, JSON.stringify(status405.headers));
const launch405 = makeResponse();
await transportFixture.launchHandler(makeRequest({ method: "GET" }), launch405);
check("a wrong method on the launch route is 405 with allow", launch405.statusCode === 405 && launch405.headers.allow === "POST" && launch405.ended === true, JSON.stringify(launch405.headers));
const notJson = makeResponse();
await transportFixture.launchHandler(makeRequest({ method: "POST", headers: { "content-type": "text/plain" }, body: "{}" }), notJson);
check("a non-JSON content-type is 415", notJson.statusCode === 415 && JSON.parse(notJson.body).reason === "unsupported-media-type", String(notJson.body));
checkNoStore("a 415", notJson);
const noContentType = makeResponse();
await transportFixture.launchHandler(makeRequest({ method: "POST", body: "{}" }), noContentType);
check("a missing content-type is 415", noContentType.statusCode === 415, String(noContentType.body));
const oversized = makeResponse();
await transportFixture.launchHandler(makeRequest({ method: "POST", headers: { "content-type": "application/json" }, body: Buffer.alloc(64 * 1024 + 1, 0x61) }), oversized);
check("a body past the documented 64 KiB ceiling is 413", oversized.statusCode === 413 && JSON.parse(oversized.body).reason === "payload-too-large", String(oversized.body));
checkNoStore("a 413", oversized);
// The ceiling is "at most 64 KiB", so exactly 64 KiB of valid JSON (padded with
// JSON-insignificant spaces) must still be read, not refused.
const boundaryBody = JSON.stringify({ sessionId: "session-absent", path: "inside.txt" });
const paddedBody = boundaryBody + " ".repeat(64 * 1024 - Buffer.byteLength(boundaryBody));
const atCeiling = makeResponse();
await routeFixture({ config: routeConfig({ editorCommand: successEditor }) }).launchHandler(
  makeRequest({ method: "POST", headers: { "content-type": "application/json" }, body: paddedBody }),
  atCeiling,
);
check("a body of exactly 64 KiB is read, not refused as oversized", atCeiling.statusCode !== 413, `${atCeiling.statusCode} ${String(atCeiling.body)}`);
for (const [label, text] of [
  ["not JSON", "{"],
  ["JSON but not an object", "42"],
  ["JSON missing sessionId", JSON.stringify({ path: "inside.txt" })],
  ["JSON with an empty path", JSON.stringify({ sessionId: "s", path: "" })],
  ["a line that is not a positive integer", JSON.stringify({ sessionId: "s", path: "inside.txt", line: 0 })],
]) {
  const malformed = makeResponse();
  await transportFixture.launchHandler(makeRequest({ method: "POST", headers: { "content-type": "application/json" }, body: text }), malformed);
  check(`a malformed body (${label}) is 400`, malformed.statusCode === 400 && malformed.ended === true, `${malformed.statusCode} ${String(malformed.body)}`);
  checkNoStore(`a 400 (${label})`, malformed);
}

// 14. The status route: disabled answers without consulting the command at all,
//     an unresolvable command is not-installed, a resolvable one is available.
const statusFixture = routeFixture({ config: routeConfig({ editorCommand: successEditor }) });
const availableRes = makeResponse();
await statusFixture.statusHandler(makeRequest({ method: "GET" }), availableRes);
const availableBody = JSON.parse(availableRes.body);
check(
  "a resolvable command answers available with the executable",
  availableRes.statusCode === 200 && availableBody.available === true && availableBody.executable === successEditor,
  String(availableRes.body),
);
checkNoStore("an available status", availableRes);
const notInstalledFixture = routeFixture({ config: routeConfig({ editorCommand: missingEditor }) });
const notInstalledRes = makeResponse();
await notInstalledFixture.statusHandler(makeRequest({ method: "GET" }), notInstalledRes);
check(
  "an unresolvable command answers not-installed",
  notInstalledRes.statusCode === 200 && JSON.parse(notInstalledRes.body).available === false && JSON.parse(notInstalledRes.body).reason === "not-installed",
  String(notInstalledRes.body),
);
for (const command of [successEditor, missingEditor]) {
  const disabledFixture = routeFixture({ config: routeConfig({ openInVscode: false, editorCommand: command }) });
  const disabledRes = makeResponse();
  await disabledFixture.statusHandler(makeRequest({ method: "GET" }), disabledRes);
  check(
    `the switch off answers unavailable/disabled before any command probe (${command === successEditor ? "resolvable" : "unresolvable"} command)`,
    disabledRes.statusCode === 200 && JSON.parse(disabledRes.body).available === false && JSON.parse(disabledRes.body).reason === "disabled",
    String(disabledRes.body),
  );
  checkNoStore("a disabled status", disabledRes);
}

// 15. The launch route's failure-to-status mapping, driven by real conditions.
const liveSessions = { get: (id) => (id === "session-live" ? { header: { cwd: wsRoot } } : undefined) };
const mappingFixture = routeFixture({ config: routeConfig({ editorCommand: successEditor }), sessions: liveSessions });
const notFound = await callLaunch(mappingFixture, { sessionId: "session-live", path: "nope.txt" });
check("unresolvable maps to 404", notFound.statusCode === 404 && JSON.parse(notFound.body).reason === "unresolvable", `${notFound.statusCode} ${String(notFound.body)}`);
checkNoStore("a 404", notFound);
const forbidden = await callLaunch(mappingFixture, { sessionId: "session-live", path: "../outside.txt" });
check("outside-workspace maps to 403", forbidden.statusCode === 403 && JSON.parse(forbidden.body).reason === "outside-workspace", `${forbidden.statusCode} ${String(forbidden.body)}`);
checkNoStore("a 403", forbidden);
const disabledLaunchFixture = routeFixture({ config: routeConfig({ openInVscode: false }), sessions: liveSessions });
const disabledLaunch = await callLaunch(disabledLaunchFixture, { sessionId: "session-live", path: "inside.txt" });
check("disabled maps to 503", disabledLaunch.statusCode === 503 && JSON.parse(disabledLaunch.body).reason === "disabled", `${disabledLaunch.statusCode} ${String(disabledLaunch.body)}`);
checkNoStore("a 503 (disabled)", disabledLaunch);
const notInstalledLaunchFixture = routeFixture({ config: routeConfig({ editorCommand: missingEditor }), sessions: liveSessions });
const notInstalledLaunch = await callLaunch(notInstalledLaunchFixture, { sessionId: "session-live", path: "inside.txt" });
check("not-installed maps to 503", notInstalledLaunch.statusCode === 503 && JSON.parse(notInstalledLaunch.body).reason === "not-installed", `${notInstalledLaunch.statusCode} ${String(notInstalledLaunch.body)}`);
checkNoStore("a 503 (not-installed)", notInstalledLaunch);
const launchFailedFixture = routeFixture({ config: routeConfig({ editorCommand: failingEditor }), sessions: liveSessions });
const launchFailed = await callLaunch(launchFailedFixture, { sessionId: "session-live", path: "inside.txt" });
check("launch-failed maps to 502", launchFailed.statusCode === 502 && JSON.parse(launchFailed.body).reason === "launch-failed", `${launchFailed.statusCode} ${String(launchFailed.body)}`);
checkNoStore("a 502", launchFailed);
const launched = await callLaunch(mappingFixture, { sessionId: "session-live", path: "inside.txt" });
check(
  "a successful launch is 200 with {ok:true,file}",
  launched.statusCode === 200 && JSON.parse(launched.body).ok === true && JSON.parse(launched.body).file === insideReal,
  `${launched.statusCode} ${String(launched.body)}`,
);
checkNoStore("a 200", launched);

// 16. Every failure path answers the response (a handler rejection would leave
//     it open). The 405 and the fence's own response carry no JSON body, so the
//     module's "every response is no-store JSON" wording does not hold for those
//     two literally; this check pins what the routes actually answer.
check(
  "every driven response is ended (no handler rejection left one open)",
  [rejectedRes, status405, launch405, notJson, noContentType, oversized, availableRes, notInstalledRes, notFound, forbidden, disabledLaunch, notInstalledLaunch, launchFailed, launched].every((res) => res.ended === true),
);
check("the 405 answer carries no JSON body", status405.body === undefined && launch405.body === undefined);

// 17. The two fields are read FRESH PER REQUEST from the settings provider, so
//     a settings.yaml edit takes effect on the next request; and the row config
//     answers when there is no provider at all.
const providerBox = { value: { openInVscode: true, editorCommand: successEditor } };
const provider = { get: (ns) => (ns === host.SETTINGS_NAMESPACE ? providerBox.value : undefined) };
const freshFixture = routeFixture({ config: routeConfig({ openInVscode: false, editorCommand: missingEditor }), settings: provider });
const freshFirst = makeResponse();
await freshFixture.statusHandler(makeRequest({ method: "GET" }), freshFirst);
check(
  "the registered section wins over the row config on the first request",
  JSON.parse(freshFirst.body).available === true && JSON.parse(freshFirst.body).executable === successEditor,
  String(freshFirst.body),
);
providerBox.value = { openInVscode: false };
const freshSecond = makeResponse();
await freshFixture.statusHandler(makeRequest({ method: "GET" }), freshSecond);
check(
  "the second request observes the new value (no restart, no cached settings)",
  JSON.parse(freshSecond.body).available === false && JSON.parse(freshSecond.body).reason === "disabled",
  String(freshSecond.body),
);
providerBox.value = { openInVscode: true, editorCommand: missingEditor };
const freshThird = makeResponse();
await freshFixture.statusHandler(makeRequest({ method: "GET" }), freshThird);
check(
  "the third request observes the new command, with the row config still filling absent fields",
  JSON.parse(freshThird.body).available === false && JSON.parse(freshThird.body).reason === "not-installed",
  String(freshThird.body),
);
// The launch route shares `editorSettingsOf`, but a check of its own keeps the
// freshness a property of BOTH routes rather than of the status handler alone.
const launchProviderBox = { value: { openInVscode: false } };
const launchProvider = { get: (ns) => (ns === host.SETTINGS_NAMESPACE ? launchProviderBox.value : undefined) };
const freshLaunchFixture = routeFixture({
  config: routeConfig({ openInVscode: false, editorCommand: missingEditor }),
  settings: launchProvider,
  sessions: liveSessions,
});
const freshLaunchFirst = await callLaunch(freshLaunchFixture, { sessionId: "session-live", path: "inside.txt" });
check(
  "the launch route reads the section fresh (first request: disabled)",
  freshLaunchFirst.statusCode === 503 && JSON.parse(freshLaunchFirst.body).reason === "disabled",
  `${freshLaunchFirst.statusCode} ${String(freshLaunchFirst.body)}`,
);
launchProviderBox.value = { openInVscode: true, editorCommand: successEditor };
const freshLaunchSecond = await callLaunch(freshLaunchFixture, { sessionId: "session-live", path: "inside.txt" });
check(
  "the launch route reads the section fresh (second request: launched)",
  freshLaunchSecond.statusCode === 200 && JSON.parse(freshLaunchSecond.body).ok === true && JSON.parse(freshLaunchSecond.body).file === insideReal,
  `${freshLaunchSecond.statusCode} ${String(freshLaunchSecond.body)}`,
);
const noProviderOff = routeFixture({ config: routeConfig({ openInVscode: false }) });
const noProviderOffRes = makeResponse();
await noProviderOff.statusHandler(makeRequest({ method: "GET" }), noProviderOffRes);
check(
  "without a settings provider the row config answers (off)",
  JSON.parse(noProviderOffRes.body).available === false && JSON.parse(noProviderOffRes.body).reason === "disabled",
  String(noProviderOffRes.body),
);
const noProviderOn = routeFixture({ config: routeConfig({ editorCommand: successEditor }) });
const noProviderOnRes = makeResponse();
await noProviderOn.statusHandler(makeRequest({ method: "GET" }), noProviderOnRes);
check(
  "without a settings provider the row config answers (available)",
  JSON.parse(noProviderOnRes.body).available === true && JSON.parse(noProviderOnRes.body).executable === successEditor,
  String(noProviderOnRes.body),
);

// 18. workspaceRootOf reads the live session's cwd and nothing for an unknown
//     one; an empty cwd is as good as unknown.
// `workspaceRootOf` takes the STORE (see its contract): the route obtains it via
// `ctx.inject(["sessions"], …)`, because a fiber refuses `ctx.sessions` outright.
const liveStore = { get: (id) => (id === "live" ? { header: { cwd: wsRoot } } : undefined) };
check("workspaceRootOf returns the live session cwd", routesApi.workspaceRootOf(liveStore, "live") === wsRoot, String(routesApi.workspaceRootOf(liveStore, "live")));
check("workspaceRootOf returns undefined for an unknown session", routesApi.workspaceRootOf(liveStore, "gone") === undefined);
check(
  "workspaceRootOf returns undefined when the cwd is empty",
  routesApi.workspaceRootOf({ get: () => ({ header: { cwd: "" } }) }, "any") === undefined,
);
//#endregion

process.on("exit", () => {
  for (const path of cleanups) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Cleanup is best-effort; a leftover scratch file must not mask a result.
    }
  }
});

console.log(
  failures.length === 0
    ? "\nall checks passed"
    : `\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`,
);
process.exit(failures.length === 0 ? 0 : 1);
