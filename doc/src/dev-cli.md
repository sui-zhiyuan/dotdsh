# The `dev_apply` CLI

`uv run python -m dev_apply` is this repository's whole dev loop — three steps, in order:

1. **build** — `pnpm -r build` in the repo root (skipped with `--no-build`): every TypeScript
   plugin package compiles `src/*.ts` into its own `lib/`.
2. **link** — one `dsh plugin --profile <name> add link:<absolute path> …` covering every
   package under `node_src/`: the `@dsh-external/dotdsh` bundle and each plugin package.
   pnpm writes the profile's `package.json`, and dsh appends the bundle to
   `dsh.profile.bundles` by itself; the plugin packages stay plain dependencies.
3. **remind** — it always prints `restart dsh to load the plugin code`, without trying to
   work out whether a restart is really needed. You know what you changed.

That is the whole command. It never copies a file, never writes into this repository, and
never touches the profile's own `cordis.patch.yml` — the profile manifest is pnpm's, the
layer list is dsh's, and the user layer is the user's.

## How the rows reach the profile

They do not travel through this command at all. `node_src/dotdsh` is a **bundle**: dsh reads
its `cordis.patch.yml` as one patch layer because the package is listed in
`dsh.profile.bundles`, and `dsh plugin add` puts it there by itself. Composition order is
bundle layers → the profile's own `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` →
`--patch` overlays, so a profile can still override or disable any row this repository ships.

## Why a restart

- Plugin **code**: Node evaluates an ES module once per process, and dsh mounts its HMR
  plugin with `root: []` — config watching only, no module watching.
- Plugin **rows**: bundle layers are read once at boot.

Only `$DSH_HOME/profiles/<name>/cordis.patch.yml` and `$DSH_HOME/cordis.patch.yml`
hot-reload while dsh runs, so a quick config experiment belongs there, not here.

## What a restart costs (measured on this machine)

| Step | Cost |
|---|---|
| compose the full web tree (146 rows, including the dotdsh bundle's) | 0.06 s |
| load the module graph (144 plugin packages) | ≈1.1 s |
| mount, bind the port, reconnect the browser | not measured here; seconds |
| **total, warm cache** | **≈1–3 s** |

Sessions are not lost: transcripts are append-only JSONL under `$DSH_HOME/sessions`, and the
projection cache is persisted under `$DSH_HOME/storages/session_projcache`, so a restart
folds a checkpoint plus the tail instead of recomputing. What a restart does change is the
model's prefix cache: if the tool set or the system prompt changed, the first request after
the restart is a cache miss; if only an `execute()` body changed, the prefix is identical.

## Options

| Flag | Meaning |
|---|---|
| `--profile <name>` | target profile under `$DSH_HOME/profiles` (default: `web`) |
| `--no-build` | skip `pnpm -r build` |
| `--dsh <path>` | dsh executable (default: `PATH` lookup; the command fails without one) |

`--help` prints the same list.

## Verifying without touching the real `~/.dsh`

[AGENTS.md](./AGENTS.md) has the recipe: a stub `dsh` plus a temporary `DSH_HOME` shows the
exact `dsh plugin add` command line, and the real `dsh` against the same temporary home shows
the bundle landing in `dsh.profile.bundles`.

## Naming and shape

The CLI is two files: `__main__.py` (everything) and `__init__.py` (the package docstring).
Paths follow the repository convention — `repo_*` for this repository, `dsh_*` for
`$DSH_HOME`, `_dir`/`_file` for the kind — which [AGENTS.md](./AGENTS.md) states in full.
The repo root is found by walking up from the module's own location for
`package.json` + `book.toml` + `pyproject.toml`, so the command works from any directory.
