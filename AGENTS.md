# AGENTS.md

Conventions for AI agents working in this repository. Human-facing documentation lives in `README.md` and `doc/src/` (mdbook).

## Repository layout (polyglot project)

| Path | Managed by | Role |
|---|---|---|
| `doc/` | mdbook (root `book.toml`) | Documentation source; `SUMMARY.md` is the table of contents |
| `node_src/` | pnpm (root `package.json` + `pnpm-workspace.yaml`) | Node source tree: one package per directory. `node_src/dotdsh/` is **the plugin-store package** (`@dsh-external/dotdsh`): declares `dsh.bundle.patch = "./cordis.patch.yml"`, a pure patch carrier with no runtime code |
| `node_src/<id>/` | pnpm | Individual plugin packages, siblings of the store; ids match `applist.yaml` ids one-to-one |
| `dsh_home/` | — | Version-controlled mirror of `$DSH_HOME` (sync source, see below) |
| `scripts/` | Python (PEP 723, `uv run`) | Tooling scripts |
| `target/` | build tools | All build artifacts (gitignored) |
| `py_src/` (reserved) | uv + pyproject | Future Python projects; when one appears, add a root `pyproject.toml` and follow the output convention |

## Common commands

```sh
uv run scripts/gen_applist.py    # applist.yaml → node_src/dotdsh/cordis.patch.yml
uv run scripts/sync_home.py      # dsh_home/ → $DSH_HOME, install plugins from applist (--dry-run/--force/--dsh)
pnpm install                     # install node_src package dependencies (incl. peerDependencies)
pnpm build                       # compile every package's src/*.ts → lib/ (tsc, in-package)
mdbook build                     # build the docs
```

- Tooling scripts are always **Python + PEP 723** (a `# /// script` block in the file header declares dependencies) and are run with `uv run`; never write Node-based tooling scripts.
- Scripts may need `UV_CACHE_DIR` to redirect the uv cache (sandboxed/CI environments).

## Output convention

- Repo-level build artifacts go into `target/<language>/` (gitignored): `target/book` (mdbook, active), `target/node` (test/coverage reports), `target/python` (reserved).
- Package build output: each publishable Node package compiles `src/*.ts` into its own **`lib/`** (tsc, same pattern as dsh's own packages). `lib/` is **gitignored build output** — freshness is guaranteed at the point of use: `sync_home.py` runs `pnpm -r build` before installing, and each package's `prepublishOnly` hook builds before publishing. Never point package builds into `target/`.
- `node_src/dotdsh/cordis.patch.yml` is **generated but must be committed** (the store package needs it present to install/publish). Never edit it by hand: change `applist.yaml` and re-run gen.

## dsh (DeepSeek Harness) contract cheat sheet

- **bundle**: an npm package whose `package.json` declares `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — the plugin form that contributes one patch layer.
- **patch rows**: a top-level YAML array; `{ insert: [ {id, name, config} ] }` inserts rows; `{ id, disabled, config }` overrides by id; last write wins per id; `config` replaces the whole row's config (no deep merge).
- **profile**: `$DSH_HOME/profiles/<name>/` holds `package.json` (`dsh.profile.bundles` + `patchReload`), `cordis.patch.yml` (user layer), `pnpm-workspace.yaml`; `cordis.yml` is rewritten on every boot and must never be committed or hand-edited.
- **Composition order**: bundle layers (in order) → profile user layer → `$DSH_HOME/cordis.patch.yml` → `--patch` overlays.
- **Hot-reload boundary**: profile and home `cordis.patch.yml` layers hot-reload; **bundle-layer changes (incl. `node_src/dotdsh/cordis.patch.yml`) require a dsh restart**.
- **`dsh plugin --profile <n> install`**: forwards `pnpm install` in the profile directory and reconciles `dsh.profile.bundles` (deps declaring `dsh.bundle` join the layer list).
- **Local plugin installs (this repo's approach)**: `sync_home.py` writes `link:<absolute path>` dependencies into the profile `package.json` and then calls `dsh plugin install`. **Do not use `dsh plugin add <path>`**: on this environment pnpm 12 + Node 26 fails to parse directory arguments as local packages (it treats them as registry names and errors).
- **Plugin shape**: `export { name, inject, Config, apply }`; tools register via `ctx.tools.register(defineTool({...}))` from `@deepseek-ai/dsh-tools`; `Config` uses `@deepseek-ai/schemastery`.

## Adding a plugin

1. Create a package under `node_src/<id>/` (package.json + `src/index.ts` + `tsconfig.json`; sources are TypeScript, built to `lib/`).
2. Add an entry `{id, package, enabled, config}` to `apps` in `applist.yaml`.
3. `uv run scripts/gen_applist.py` + `pnpm build` → verify: sync under a temporary `DSH_HOME` and boot.

## Red lines

- `dsh_home/` holds only controlled `$DSH_HOME` files; **credentials (`.credentials.yaml`/`.env`), node_modules, sessions, and `cordis.yml` must never be committed**; the `settings.yaml` template contains only commented examples.
- Verify sync/boot only under a temporary `DSH_HOME` (`mktemp -d`); **never touch the user's real `~/.dsh`** (unless the user explicitly asks to run sync).
- Run `--dry-run` before writing; sync never overwrites existing target files by default.
- Documentation language: English.
