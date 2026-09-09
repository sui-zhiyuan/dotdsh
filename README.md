# dotdsh

> My dsh (DeepSeek Harness) plugin store: one plugin package per `node_src/` directory, every plugin row in the root `cordis.patch.yml`, both wired into a profile by the `dotdsh_dev` dev-loop script.

## Layout

| Path | Role |
|---|---|
| `node_src/` | One pure plugin package per directory (TypeScript, built to gitignored `lib/`); `hello-world` is the example |
| `cordis.patch.yml` | The single hand-maintained patch source: every plugin row (insert/override) lives here |
| `py_src/` | uv workspace: the `dotdsh_dev` dev-loop CLI (`uv run python -m dotdsh_dev`) |
| `dsh_home/` | `settings.yaml` reference template (one-time manual copy) |
| `doc/src/` | mdbook documentation |

## Quick start

```sh
# 0. One-time: install workspace dependencies
pnpm install

# 1. Dev sync into the web profile: builds the plugins, link-installs them,
#    and copies cordis.patch.yml to the profile's user layer.
uv run python -m dotdsh_dev --dry-run   # inspect first
uv run python -m dotdsh_dev

# 2. A running profile hot-reloads the patch rows immediately; restart dsh
#    when plugin code (src/*.ts) changed.
dsh --profile web
```

## Adding a plugin

1. Create a package under `node_src/<id>/` (`package.json` + `src/index.ts` + `tsconfig.json`);
2. Add its row (`id`, `name`, `config`) to the root `cordis.patch.yml`;
3. `uv run python -m dotdsh_dev` — the row hot-reloads; restart dsh to load new plugin code.

## Publishing

```sh
pnpm publish   # pnpm -r publish --access public, per package
```

## Documentation

The mdbook bundles the project TODO list together with this README and `AGENTS.md`:

```sh
mdbook build        # output to target/book/
```
