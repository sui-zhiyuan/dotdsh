# AGENTS.md

Conventions for AI agents working in this repository. Human-facing documentation lives in `README.md` and `doc/src/` (mdbook).

## Repository layout (polyglot project)

| Path | Managed by | Role |
|---|---|---|
| `doc/` | mdbook (root `book.toml`) | Documentation source; `SUMMARY.md` is the table of contents |
| `node_src/<id>/` | pnpm (root `package.json` + `pnpm-workspace.yaml`) | One plugin package per directory (TypeScript `src/*.ts` → gitignored `lib/`); it contributes no patch layer of its own. A **dual-face** package additionally declares `dsh.client` and commits its browser half at `client/index.js` (`ui-tweaks`) |
| `node_src/dotdsh/` | pnpm (same workspace) | The `@dsh-external/dotdsh` **bundle**: its `cordis.patch.yml` holds every plugin row and its `dependencies` (`workspace:*`) name every plugin package — dsh composes the patch as one layer |
| `py_src/dev-apply/` | uv workspace (root `pyproject.toml` + `uv.lock`) | The `dev_apply` CLI, run with `uv run python -m dev_apply`: build + link-install + restart reminder |
| `dsh_home/` | — | `settings.yaml` reference template only (one-time manual copy; nothing syncs it automatically) |
| `target/` | build tools | All build artifacts (gitignored) |

## Naming conventions (Python tooling)

- **Ownership prefix** — a name says which side it belongs to: `repo_*` for this repository, `dsh_*` for `$DSH_HOME`. Bare names like `root` or `profile_dir` are not acceptable.
- **Path suffix** — `_dir` for directories, `_file` for files, so a path reads as `<side>_<what>_<kind>`.
- Examples: `repo_dir`, `node_src_dir`, `dsh` (the executable), `profile_dir`.

## Verifying without touching the real `~/.dsh`

`dev_apply` writes only inside the profile directory, so a stub `dsh` plus a temporary `DSH_HOME` verifies the whole command sequence with no network and no `~/.dsh` access:

```sh
TMP=$(mktemp -d); mkdir -p "$TMP/profiles/web"
printf '{"name":"web-profile","dsh":{"profile":{"bundles":[],"patchReload":"live"}}}' > "$TMP/profiles/web/package.json"
STUB=$(mktemp -d)/dsh-stub; printf '#!/bin/sh\necho "[stub dsh] $*"\n' > "$STUB"; chmod +x "$STUB"
DSH_HOME="$TMP" uv run python -m dev_apply --no-build --dsh "$STUB"
# [stub dsh] plugin --profile web add link:<repo>/node_src/dotdsh link:<repo>/node_src/hello-world
rm -rf "$TMP"
```

Running the same temporary `DSH_HOME` with the real `dsh` proves the plugin side too: pnpm writes the profile manifest, dsh adds the bundle to `dsh.profile.bundles`, and `dsh --profile web --dump-config` then shows the row annotated `# == @dsh-external/dotdsh`.

To boot that temporary home for real, copy the real profile's bundle list into it (`@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app`, `@dsh-external/dotdsh`) — a profile whose `bundles` holds only the dotdsh bundle composes *just* these rows, so a host plugin like `hello-world` stays `pending (waiting for service: tools)` and the boot fails with `1 entry did not activate`. Then serve it on a free port and read the boot graph instead of the UI:

```sh
DSH_HOME="$TMP" dsh --profile web --no-open --port 3099 > "$TMP/web.log" 2>&1 &   # prints ?token=…
curl -sL -c "$TMP/c" -b "$TMP/c" "http://127.0.0.1:3099/?token=$(sed -n 's/.*token=//p' "$TMP/web.log")" -o "$TMP/index.html"
grep -o '{"id":"<package>"[^}]*}' "$TMP/index.html"   # boot-graph entry + its /plugins/??… bundle URL
```

## Common commands

```sh
uv sync                                  # create/refresh .venv: workspace members + the root dev group (ruff)
uv run python -m dev_apply               # build the packages, link-install them into the web profile, remind you to restart dsh
uv run ruff check py_src/dev-apply       # lint (ruff comes from the root dev group)
uv run ruff format py_src/dev-apply      # format
pnpm install                             # install node_src package dependencies (incl. peerDependencies)
pnpm build                               # compile every package's src/*.ts → lib/ (tsc, in-package)
pnpm test                                # run each package's checks (ui-tweaks: the node-half contract and the browser half; built-ins only, no harness needed)
pnpm release                             # publish every package (pnpm -r publish --access public)
mdbook build                             # build the docs
```

- Python tooling lives in the **uv workspace** (root `pyproject.toml`, member under `py_src/`, committed `uv.lock`): one CLI module `dev_apply` executed as `uv run python -m dev_apply`. Never single-file PEP 723 scripts — PEP 723 cannot express a multi-file tool.
- `dsh` must be resolvable: `dev_apply` takes it from `PATH` or `--dsh <path>` and **fails otherwise** (it never installs a harness on the fly). Install it once with `pnpm add -g @deepseek-ai/dsh`; pnpm 12 refuses to finish that install while a dependency's build scripts are unapproved — it names those packages, so re-run with `--allow-build=<package>` for each.
- Dev tools live in the **workspace root**, not in the member: `[dependency-groups] dev` (PEP 735, installed by `uv sync` by default) plus the single `[tool.ruff]` config; `py_src/dev-apply/` stays a plain runtime package with no dependencies.
- `dev_apply` locates the repo root via `repo_root_dir()`: anchored at the module's own file location, which uv's editable install resolves into the repo source tree (independent of cwd and venv location), walking up for the root markers `package.json` + `book.toml` + `pyproject.toml` (all three must be present).
- uv state lives under gitignored `target/` via root `uv.toml` (`cache-dir`); the project venv is `.venv/` (gitignored). No `UV_CACHE_DIR` override needed in sandboxed/CI environments.

## Output convention

- Repo-level build artifacts go into `target/<language>/` (gitignored): `target/book` (mdbook, active), `target/node` (test/coverage reports), `target/python` (uv cache).
- Package build output: each publishable Node package compiles `src/*.ts` into its own **`lib/`** (tsc, same pattern as dsh's own packages). `lib/` is **gitignored build output** — freshness is guaranteed at the point of use: `dev_apply` runs `pnpm -r build` before linking, and each package's `prepublishOnly` hook builds before publishing. Never point package builds into `target/`.
- **Plugin rows are hand-maintained in `node_src/dotdsh/cordis.patch.yml`.** dsh composes that file as the bundle's patch layer, so a row change takes effect on the next dsh start. The profile's own `cordis.patch.yml` belongs to the user and is never written by this repository.
- **A browser half (`client/index.js`) is committed source, not build output.** dsh serves those exact bytes and fails the boot when the file is missing, so it cannot live under gitignored `lib/`; nothing builds or type-checks it either (`tsc` only compiles `src/`), which is why a change there is guarded by review and the committed checks at `node_src/ui-tweaks/test/verify-client.mjs` and `verify-host.mjs` (`pnpm test`) rather than by the build. Each check states its own boundary in its header: the browser one proves the manifest contract, the boot-protocol registration and each tweak's decisions against a fake DOM, not that the page really broke the line or re-rendered the copy; the host one proves the node half's registration and the name-level agreement with the browser half, not that dsh resolved or persisted a section.

## dsh (DeepSeek Harness) contract cheat sheet

- **bundle**: an npm package whose `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. Listing that package in `dsh.profile.bundles` composes its patch file as one layer. This repo has exactly one bundle, `node_src/dotdsh`; `dsh plugin add` appends it to that list by itself, and only its patch file is read — dsh never imports the package.
- **plugin package**: exports a Cordis plugin and contributes rows to nobody's patch. Every `node_src/<id>/` except `dotdsh` is one — the same shape as dsh's own `dsh-tool-*` packages (of the 224 `@deepseek-ai` packages installed here, 6 are bundles; the rest are plain).
- **dual-face plugin package**: additionally declares `"dsh": { "client": { "platform": "web" } }` and exports a `./client` subpath. The row still mounts the node half, and *being an active Loader entry* is what makes dsh's client-modules scan find the package, resolve `exports["./client"]` and add that file to the browser boot graph as one cordis entry. A browser half is a classic script that registers itself with `window.__ModuleLoader__.load({id, factory})`, where `id` MUST equal the package name (the Web shell creates one cordis entry per boot-graph id and resolves it through that registration); `factory(require)` returns the module exports and `exports.apply` is the client plugin. `dsh.client.inject`/`external` name the client modules the bundle `require`s — this repo's halves require nothing. The boot graph carries `id`/`url`/`rev`/`inject`/`external`/`immediately` and **no row config**, so a browser half cannot read its row's `config`; configuration reaches a page only through a settings namespace, which is what ui-tweaks' node half registers (`ctx.inject(["settings"], …)` + `ctx.settings.register(ns, schema, {base: config})`, the row's config as the composition base layer) and its browser half reads (`ctx.inject(["settingsScope"], …)` + `scope.bind({namespace})`, adopted from the scope snapshot). Every shipped browser preference (`ui-chat`, `ui-conversation`, `ui-theme`) travels that way.
- **patch rows**: a top-level YAML array; `{ insert: [ {id, name, config} ] }` inserts rows; `{ id, disabled, config }` overrides by id; last write wins per id; `config` replaces the whole row's config (no deep merge).
- **profile**: `$DSH_HOME/profiles/<name>/` holds `package.json` (`dsh.profile.bundles` + `patchReload`), `cordis.patch.yml` (the user's own layer), `pnpm-workspace.yaml`; `cordis.yml` is rewritten on every boot and must never be committed or hand-edited.
- **Composition order**: bundle layers (in `dsh.profile.bundles` order) → profile user layer → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays.
- **`--patch <file>` is a boot-time overlay**: it applies to the process being started, so it cannot be injected into a running one. This repo does not need it: its rows ship as a bundle layer, and per-profile deviations belong in the profile's own `cordis.patch.yml`.
- **Two node_modules**: `$DSH_HOME/profiles/node_modules/` is a shared fallback tree that boot rebuilds from the CLI install anchor, so every profile can resolve the harness packages; `$DSH_HOME/profiles/<name>/node_modules/` is that profile's own slot (pnpm installs plus boot's owned links) and shadows the shared tree.
- **Hot-reload boundary**: bundle layers — including `node_src/dotdsh/cordis.patch.yml` — are read **once at boot**. Only `$DSH_HOME/profiles/<name>/cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml` hot-reload while dsh runs. So both a plugin-code change (`src/*.ts` → rebuilt `lib/`) and a row change need a dsh restart; only user-layer overrides apply live.
- **`dsh plugin --profile <n> <pnpm args>`**: initializes the profile on first use, forwards the arguments to pnpm in the profile directory, then reconciles `dsh.profile.bundles` (a dependency whose manifest declares `dsh.bundle` joins the layer list; a bundle-less one only warns). `dev_apply` uses `add`.
- **Local plugin installs (this repo's approach)**: `dev_apply` runs one `dsh plugin --profile <n> add link:<absolute path> …` covering every `node_src/*` package, so **pnpm writes the profile manifest** and dsh adds the bundle to the layer list. A `link:` install never materializes the linked package's own dependencies in the profile, which is why every plugin package is linked individually — the rows name packages that Node must resolve **from the profile directory**.
- **Plugin shape**: `export { name, inject, Config, apply }`; tools register via `ctx.tools.register(defineTool({...}))` from `@deepseek-ai/dsh-tools`; `Config` uses `@deepseek-ai/schemastery`. `name` follows dsh's own convention: the package name minus scope and prefix (`@dsh-external/dotdsh-hello-world` → `hello-world`).

## Adding a plugin

1. Create the package under `node_src/<id>/` (package.json + `src/index.ts` + `tsconfig.json`; sources are TypeScript, built to `lib/`). Give it its harness `peerDependencies`, so pnpm records a lockfile importer for it. For a browser half, additionally add `"exports": {"./client": …}` → a committed `client/index.js` and the `"dsh": {"client": {"platform": "web"}}` declaration; prefer extending an existing dual-face package (one `tweaks` registry, one row) over adding a new tiny package.
2. Add its row (`id`, `name`, `config`) to `node_src/dotdsh/cordis.patch.yml`.
3. Add it to the bundle's `dependencies` as `"workspace:*"`, then `pnpm install` — that is the edge a published install of the bundle needs (pnpm rewrites `workspace:*` to a real version at pack time).
4. `uv run python -m dev_apply` — builds the packages, links them into the profile, prints the restart reminder.
5. Restart dsh: the new module and the new row both load at boot. For a browser half that restart is also what composes the boot graph, so the row composing is not proof enough — check the boot graph under a temporary `DSH_HOME` (see above) before reporting a browser half as done.

## Red lines

- Plugin rows are edited **only** in `node_src/dotdsh/cordis.patch.yml`.
- The profile's `cordis.patch.yml` belongs to the user: nothing in this repository writes it. Per-profile overrides and disables go there; machine-wide ones go in `$DSH_HOME/cordis.patch.yml`.
- `dsh_home/` holds only controlled `$DSH_HOME` files; **credentials (`.credentials.yaml`/`.env`), node_modules, sessions, and `cordis.yml` must never be committed** (`.gitignore` also guards those paths); the `settings.yaml` template contains only commented examples.
- Verify sync/boot only under a temporary `DSH_HOME` (`mktemp -d`); **never touch the user's real `~/.dsh`** without the user explicitly asking to run `dev_apply` against it.
- `dev_apply` writes only into the profile directory; it never writes into this repository.
- **No absolute paths in committed files.** Machine-local paths — the `link:` specs in the profile manifest, an HMR `root` — live in `$DSH_HOME` layers, and `dev_apply` computes them at run time; `workspace:*` is how the repository refers to its own packages.
- Documentation language: English.
