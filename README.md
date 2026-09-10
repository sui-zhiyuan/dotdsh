# dotdsh

> My dsh (DeepSeek Harness) plugin repo: the plugin packages under `node_src/`, plus the
> `@dsh-external/dotdsh` bundle whose patch layer mounts them into a profile. `dev_apply`
> builds the packages, link-installs them into a profile, and reminds you to restart dsh.

## Layout

| Path | Role |
|---|---|
| `node_src/<id>/` | One plugin package per directory. Single-face: TypeScript `src/` built to gitignored `lib/` (`hello-world`). Dual-face (also declares `dsh.client`): the same node half plus a committed, hand-authored browser half at `client/index.js` (`ui-tweaks`) |
| `node_src/dotdsh/` | The `@dsh-external/dotdsh` bundle: its `cordis.patch.yml` holds every plugin row, and its `dependencies` (`workspace:*`) name every plugin package |
| `py_src/dev-apply/` | uv workspace member: the `dev_apply` CLI (`uv run python -m dev_apply`) |
| `dsh_home/` | `settings.yaml` reference template (one-time manual copy) |
| `doc/src/` | mdbook documentation |

## Plugins

| Package | Row id | What it does |
|---|---|---|
| `@dsh-external/dotdsh-hello-world` | `hello-world` | The example plugin: registers the `hello_world` tool, driven by its row's `config.greeting` |
| `@dsh-external/dotdsh-ui-tweaks` | `ui-tweaks` | One home for small browser-side behaviour changes, so each tweak does not become its own package. Today: `composer-enter-newline` — bare <kbd>Enter</kbd> breaks the line in the composer, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> sends; `llm-status-wording` — while a turn runs, the Chinese status line above the composer shows a randomly drawn DeepSeek-meme phrase. Both are switchable per machine, and the phrase bank is extendable, through the `ui-tweaks` settings namespace (`$DSH_HOME/settings.yaml`): `composerEnterNewline`, `statusWording`, `statusPhrases` |

The two tweaks are configured per machine rather than in this repository. Their namespace is the
one a browser half can actually read — a client bundle never sees its row's `config` — and the
settings file provider watches its document, so an edit applies without a restart:

```yaml
ui-tweaks:
  composerEnterNewline: true      # bare Enter breaks the line; Ctrl/Cmd+Enter sends
  statusWording: true             # random DeepSeek meme in the running-turn status line
  statusPhrases: ["自定义一句"]    # extra phrasing appended to the shipped bank
```

Unset fields fall back to this package's schema defaults (all three values above except the empty
extension list), and a row `config` in the bundle patch would sit below them as the composition
`base` layer. One caveat worth knowing: a section the schema rejects leaves the namespace
unregistered for that whole boot — the tweaks then quietly run on their defaults, and dsh reports
it only through its logger — so fix the document and restart.

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

1. Create a package under `node_src/<id>/` (`package.json` + `src/index.ts` + `tsconfig.json`). For a browser half, also point `exports["./client"]` at a committed `client/index.js` and declare `"dsh": {"client": {"platform": "web"}}` — and prefer extending an existing dual-face package (`ui-tweaks`) over adding another tiny one;
2. Add its row (`id`, `name`, `config`) to `node_src/dotdsh/cordis.patch.yml`;
3. Add it to the bundle's `dependencies` as `"workspace:*"` and run `pnpm install` — that is what a published install of the bundle needs;
4. `uv run python -m dev_apply` — builds, links, and reminds you to restart;
5. Restart dsh: the row is composed from the bundle layer at boot. For a browser half that restart is also what puts it in the boot graph, so verify the graph (see [AGENTS.md](./AGENTS.md)) instead of assuming the row was enough.

## Development

```sh
uv sync                              # refresh .venv: workspace members + the root dev group (ruff)
uv run python -m dev_apply           # build + link-install into the web profile
uv run ruff check py_src/dev-apply   # lint
uv run ruff format py_src/dev-apply  # format
mdbook build                         # docs → target/book/
pnpm test                            # per-package checks (ui-tweaks: both halves — host contract + browser half)
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
