# AGENTS.md

Conventions for AI agents working in this repository. Human-facing documentation lives in `README.md` and `doc/src/` (mdbook).

## Repository layout (polyglot project)

| Path | Managed by | Role |
|---|---|---|
| `doc/` | mdbook (root `book.toml`) | Documentation source; `SUMMARY.md` is the table of contents |
| `node_src/<id>/` | pnpm (root `package.json` + `pnpm-workspace.yaml`) | One pure plugin package per directory (TypeScript `src/*.ts` → gitignored `lib/`); ids match the row ids in the root `cordis.patch.yml` one-to-one |
| `cordis.patch.yml` | — | The single hand-maintained patch source: every plugin row (insert/override) lives here; `dotdsh_dev` copies it verbatim to the target profile's user layer |
| `py_src/` | uv workspace (root `pyproject.toml` + `uv.lock`) | Python tooling: the single `dotdsh_dev` CLI, run with `uv run python -m dotdsh_dev` |
| `dsh_home/` | — | `settings.yaml` reference template only (one-time manual copy; nothing syncs it automatically) |
| `target/` | build tools | All build artifacts (gitignored) |

## Naming conventions (Python tooling)

- **Ownership prefix** — every path and owned value says which side it belongs to: `repo_*` for this repository, `dsh_*` for `$DSH_HOME` configuration. Bare names like `root`, `patch`, `profile_dir` are not acceptable.
- **Path suffix** — `_dir` for directories, `_file` for files, so a path reads as `<side>_<what>_<kind>`.
- Examples: `repo_root_dir`, `repo_node_src_dir`, `repo_patch_file`, `repo_plugins` (data); `dsh_profile` (name), `dsh_profile_dir`, `dsh_manifest_file` (path) vs `dsh_manifest` (parsed JSON), `dsh_patch_file`, `dsh_bin_file`, `dsh_cmd` (data).

## Verifying a sync without touching the real `~/.dsh`

`--dry-run` alone is **not** enough: the effects wrappers return before touching the filesystem, so the write path (manifest write, patch copy) stays unverified. A stub `dsh` plus a temporary `DSH_HOME` exercises it with no network and no `~/.dsh` access:

```sh
TMP=$(mktemp -d); mkdir -p "$TMP/profiles/web"
printf '{"name":"web-profile","dsh":{"profile":{"bundles":[],"patchReload":"live"}}}' > "$TMP/profiles/web/package.json"
STUB=$(mktemp -d)/dsh-stub; printf '#!/bin/sh\necho "[stub dsh] $*"\n' > "$STUB"; chmod +x "$STUB"
DSH_HOME="$TMP" uv run python -m dotdsh_dev --no-build --dsh "$STUB"
diff -q cordis.patch.yml "$TMP/profiles/web/cordis.patch.yml"   # patch copied verbatim
rm -rf "$TMP"
```

## Common commands

```sh
uv sync                                # create/refresh .venv: members + the root dev group (ruff)
uv run python -m dotdsh_dev            # dev sync into the web profile: pnpm -r build + link install + patch copy
uv run python -m dotdsh_dev --dry-run  # print the steps without doing them
uv run python -m dotdsh_dev --traceback  # full traceback instead of one error line
uv run ruff check py_src/dotdsh-dev    # lint (ruff comes from the root dev group)
uv run ruff format py_src/dotdsh-dev   # format
pnpm install                           # install node_src package dependencies (incl. peerDependencies)
pnpm build                             # compile every package's src/*.ts → lib/ (tsc, in-package)
pnpm publish                           # publish every plugin package (pnpm -r publish --access public)
mdbook build                           # build the docs
```

- Python tooling lives in the **uv workspace** (root `pyproject.toml`, member under `py_src/`, committed `uv.lock`): one CLI module `dotdsh_dev` executed as `uv run python -m dotdsh_dev`. Never single-file PEP 723 scripts — PEP 723 cannot express multi-file tools.
- Dev tools live in the **workspace root**, not in the member: `[dependency-groups] dev` (PEP 735, installed by `uv sync` by default) plus the single `[tool.ruff]` config; `py_src/dotdsh-dev/` stays a plain runtime package with no dev dependencies of its own.
- `dotdsh_dev` locates the repo root via `find_repo_root()`: anchored at the module's own file location, which uv's editable install resolves into the repo source tree (independent of cwd and venv location), walking up for the root markers `package.json` + `book.toml` + `pyproject.toml` (all three must be present).
- uv state lives under gitignored `target/` via root `uv.toml` (`cache-dir`); the project venv is `.venv/` (gitignored). No `UV_CACHE_DIR` override needed in sandboxed/CI environments.

## Output convention

- Repo-level build artifacts go into `target/<language>/` (gitignored): `target/book` (mdbook, active), `target/node` (test/coverage reports), `target/python` (uv cache).
- Package build output: each publishable Node package compiles `src/*.ts` into its own **`lib/`** (tsc, same pattern as dsh's own packages). `lib/` is **gitignored build output** — freshness is guaranteed at the point of use: `dotdsh_dev` runs `pnpm -r build` before syncing, and each package's `prepublishOnly` hook builds before publishing. Never point package builds into `target/`.
- `cordis.patch.yml` is **hand-maintained and the single source of plugin rows** — `dotdsh_dev` copies it verbatim over the target profile's user layer. Edit rows here, never in `$DSH_HOME` (the script overwrites the copy).

## dsh (DeepSeek Harness) contract cheat sheet

- **bundle**: an npm package whose `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — the plugin form that contributes one patch layer. dsh's own packages (e.g. `dsh-base`, `dsh-web-app`) use this; this repo's plugins are **pure packages** and deliberately are not bundles — their rows live in the root `cordis.patch.yml` instead.
- **patch rows**: a top-level YAML array; `{ insert: [ {id, name, config} ] }` inserts rows; `{ id, disabled, config }` overrides by id; last write wins per id; `config` replaces the whole row's config (no deep merge).
- **profile**: `$DSH_HOME/profiles/<name>/` holds `package.json` (`dsh.profile.bundles` + `patchReload`), `cordis.patch.yml` (user layer), `pnpm-workspace.yaml`; `cordis.yml` is rewritten on every boot and must never be committed or hand-edited.
- **Composition order**: bundle layers (in order) → profile user layer → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays.
- **Hot-reload boundary**: profile and home `cordis.patch.yml` layers hot-reload when `patchReload: live`; the root `cordis.patch.yml` lands in the profile user layer via `dotdsh_dev`, so row changes hot-reload into the running profile **and** survive restarts. Plugin **code** changes (`src/*.ts`) and newly added/removed packages take effect on the next dsh restart after a `dotdsh_dev` run.
- **`dsh plugin --profile <n> install`**: forwards `pnpm install` in the profile directory and reconciles `dsh.profile.bundles` (deps declaring `dsh.bundle` join the layer list).
- **Local plugin installs (this repo's approach)**: `dotdsh_dev` writes `link:<absolute path>` dependencies into the profile `package.json` and then calls `dsh plugin install`. **Do not use `dsh plugin add <path>`**: on this environment pnpm 12 + Node 26 fails to parse directory arguments as local packages (it treats them as registry names and errors).
- **Plugin shape**: `export { name, inject, Config, apply }`; tools register via `ctx.tools.register(defineTool({...}))` from `@deepseek-ai/dsh-tools`; `Config` uses `@deepseek-ai/schemastery`.

## Adding a plugin

1. Create a package under `node_src/<id>/` (package.json + `src/index.ts` + `tsconfig.json`; sources are TypeScript, built to `lib/`).
2. Add its row (`id`, `name`, `config`) to the root `cordis.patch.yml`.
3. `uv run python -m dotdsh_dev` → the row hot-reloads into the running web profile; restart dsh for the plugin code itself to load.

## Red lines

- Row changes are edited **only** in the root `cordis.patch.yml`; `dotdsh_dev` overwrites the profile user layer, so hand edits in `$DSH_HOME` are lost.
- `dsh_home/` holds only controlled `$DSH_HOME` files; **credentials (`.credentials.yaml`/`.env`), node_modules, sessions, and `cordis.yml` must never be committed**; the `settings.yaml` template contains only commented examples.
- Verify sync/boot only under a temporary `DSH_HOME` (`mktemp -d`); **never touch the user's real `~/.dsh`** without the user explicitly asking to run `dotdsh_dev` against it.
- Run `--dry-run` before writing.
- Documentation language: English.
