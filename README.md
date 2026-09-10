# dotdsh

> My dsh (DeepSeek Harness) plugin set: one plugin package per `node_src/` directory, every plugin row in the root `cordis.patch.yml`, both wired into a profile by the `dotdsh_dev` dev-loop script.

## Layout

| Path | Role |
|---|---|
| `node_src/` | One pure plugin package per directory (TypeScript, built to gitignored `lib/`); `hello-world` is the example |
| `cordis.patch.yml` | The single hand-maintained patch source: every plugin row (insert/override) lives here |
| `py_src/` | uv workspace: the `dotdsh_dev` dev-loop CLI (`uv run python -m dotdsh_dev`) |
| `dsh_home/` | `settings.yaml` reference template (one-time manual copy) |
| `doc/src/` | mdbook documentation |

## Prerequisites

- `pnpm` and Node — for the plugin packages;
- `uv` — for the Python tooling;
- `dsh` on `PATH` — install it once with `pnpm add -g @deepseek-ai/dsh`. pnpm 12 refuses to
  finish that install while any dependency's build scripts are unapproved: it names those
  packages, so re-run with `--allow-build=<package>` for each of them. Without a global
  install, pass `--dsh <path>` on every `dotdsh_dev` call.

## Quick start

```sh
# 0. One-time: workspace dependencies and dev tools
pnpm install
uv sync

# 1. Dev sync into the web profile: builds the plugins, link-installs them, and
#    copies cordis.patch.yml to the profile's user layer.
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

## Development

```sh
uv sync                                # refresh .venv: workspace members + the root dev group (ruff)
uv run ruff check py_src/dotdsh-dev    # lint
uv run ruff format py_src/dotdsh-dev   # format
mdbook build                           # docs → target/book/
pnpm publish                           # pnpm -r publish --access public
```

## Documentation

`mdbook build` renders `doc/src/` into `target/book/`. The pages are:

- `doc/src/README.md` — this page: what the repository is and how to run it;
- `doc/src/dev-cli.md` — the `dotdsh_dev` steps, failure model, modules and logging;
- `doc/src/design.md` — why the repository is shaped this way;
- `doc/src/todo.md` — what is planned;
- `doc/src/AGENTS.md` — conventions for AI agents working here.
