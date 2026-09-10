# dotdsh

> My dsh (DeepSeek Harness) plugin repo: the plugin packages under `node_src/`, plus the
> `@dsh-external/dotdsh` bundle whose patch layer mounts them into a profile. `dev_apply`
> builds the packages, link-installs them into a profile, and reminds you to restart dsh.

## Layout

| Path | Role |
|---|---|
| `node_src/<id>/` | One plugin package per directory (TypeScript, built to gitignored `lib/`); `hello-world` is the example |
| `node_src/dotdsh/` | The `@dsh-external/dotdsh` bundle: its `cordis.patch.yml` holds every plugin row, and its `dependencies` (`workspace:*`) name every plugin package |
| `py_src/dev-apply/` | uv workspace member: the `dev_apply` CLI (`uv run python -m dev_apply`) |
| `dsh_home/` | `settings.yaml` reference template (one-time manual copy) |
| `doc/src/` | mdbook documentation |

## Prerequisites

- `pnpm` and Node — for the plugin packages;
- `uv` and Python 3.14+ — for the Python tooling (`uv` downloads the interpreter when it is missing);
- `dsh` on `PATH` — install it once with `pnpm add -g @deepseek-ai/dsh`. pnpm 12 refuses to
  finish that install while any dependency's build scripts are unapproved: it names those
  packages, so re-run with `--allow-build=<package>` for each of them. Without a global
  install, pass `--dsh <path>` on every `dev_apply` call.

## Quick start

```sh
# 0. One-time: workspace dependencies and dev tools
pnpm install
uv sync

# 1. Build the plugin packages and link-install every node_src/ package into the
#    web profile (dsh writes the profile manifest and adds the bundle to
#    dsh.profile.bundles by itself). `pnpm apply` is the same command.
uv run python -m dev_apply

# 2. Restart dsh — bundle layers and plugin code are read at boot.
dsh --profile web
```

## Adding a plugin

1. Create a package under `node_src/<id>/` (`package.json` + `src/index.ts` + `tsconfig.json`);
2. Add its row (`id`, `name`, `config`) to `node_src/dotdsh/cordis.patch.yml`;
3. Add it to the bundle's `dependencies` as `"workspace:*"` and run `pnpm install` — that is what a published install of the bundle needs;
4. `uv run python -m dev_apply` — builds, links, and reminds you to restart;
5. Restart dsh: the row is composed from the bundle layer at boot.

## Development

```sh
uv sync                              # refresh .venv: workspace members + the root dev group (ruff)
uv run python -m dev_apply           # build + link-install into the web profile
uv run ruff check py_src/dev-apply   # lint
uv run ruff format py_src/dev-apply  # format
mdbook build                         # docs → target/book/
pnpm release                         # pnpm -r publish --access public
```

## Documentation

`mdbook build` renders `doc/src/` into `target/book/`. The pages are:

- `doc/src/README.md` — this page: what the repository is and how to run it;
- `doc/src/dev-cli.md` — what `dev_apply` does, and what a restart costs;
- `doc/src/design.md` — why the repository is shaped this way;
- `doc/src/todo.md` — what is planned;
- `doc/src/AGENTS.md` — conventions for AI agents working here.

`doc/src/README.md` and `doc/src/AGENTS.md` are symlinks to the root files, not copies:
each page has exactly one source.
