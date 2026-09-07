# dotdsh

> My dsh (DeepSeek Harness) plugin store and dotfiles framework.
> Treat dsh as an OS: `applist.yaml` is my app list, `node_src/` is my plugin store, `dsh_home/` is my home config.

## Layout

| Path | Role |
|---|---|
| `applist.yaml` | **The app list** (the heart): declares which plugins are installed and how they are configured |
| `node_src/` | One package per directory (TypeScript, built to `lib/`): `dotdsh/` is the plugin store itself, the rest are individual plugins (`hello-world` is the example) |
| `dsh_home/` | Controlled mirror of `$DSH_HOME`: profile, home-level patch, settings templates |
| `doc/src/` | mdbook documentation |
| `scripts/` | Python tooling scripts (PEP 723, run with `uv run`) |

## Quick start

```sh
# 0. One-time: install workspace dependencies
pnpm install

# 1. Generate the store's patch layer (applist.yaml → node_src/dotdsh/cordis.patch.yml)
uv run scripts/gen_applist.py

# 2. Sync into your dsh home (default ~/.dsh; override with DSH_HOME) and install plugins.
#    This also rebuilds the TypeScript packages before installing.
uv run scripts/sync_home.py          # run --dry-run first

# 3. Boot your profile
dsh --profile dotdsh
```

Plugin sources are TypeScript (`node_src/*/src/*.ts`); `lib/` is gitignored build output that `sync_home.py` rebuilds automatically (or build manually with `pnpm build`).

## Adding a plugin

1. Create a package under `node_src/<id>/`;
2. Add `{id, package, enabled, config}` to `applist.yaml`;
3. `uv run scripts/gen_applist.py && uv run scripts/sync_home.py`.

## Documentation

The mdbook bundles the project TODO list together with this README and `AGENTS.md`:

```sh
mdbook build        # output to target/book/
```
