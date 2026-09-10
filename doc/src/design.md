# Design decisions

dotdsh is deliberately small: one plugin package per `node_src/` directory and one
hand-written patch file that wires those packages into a dsh profile. This page records
why it is shaped that way. The dsh contract itself (patch layers, composition order, hot
reload) is summarized in [AGENTS.md](./AGENTS.md).

## What this replaced

The first version kept a plugin *store*: an `applist.yaml` inventory, a Python package to
load and validate it, and a generator that turned the inventory into `cordis.patch.yml`.
Two consumers (the install path and the home-config sync) shared the store, which seemed
to justify schema validation, typed models, and a generated-but-committed patch file.

In practice the store, the generator and the "generate but commit" coupling *were* the
complexity budget, and the inventory never held more than a handful of rows. The whole
layer is gone: rows are hand-written, plugin packages are plain packages, and a single
script does the wiring.

## Decisions

| Decision | Why |
|---|---|
| Plugin packages are pure packages, not dsh bundles | A bundle is an npm package that points dsh at its own patch file; these plugins contribute rows to *this* repository's patch instead, so a bundle declaration would only add indirection |
| One hand-written `cordis.patch.yml`, copied verbatim into the profile user layer | That layer hot-reloads while dsh runs **and** is re-applied on the next boot; a `--patch` overlay would affect only a newly started process |
| Local installs use `link:` dependencies plus `dsh plugin install` | `dsh plugin add <path>` is unusable on this setup: pnpm 12 on Node 26 parses directory arguments as registry names |
| Python tooling is a uv workspace run with `python -m dotdsh_dev` | PEP 723 scripts cannot express a multi-file tool |
| The workspace root is `package = false` | The root only aggregates the environment; it should not be buildable as a wheel |
| Dev tooling lives in the root dependency group | `uv sync` installs ruff with everything else, and the member stays a plain runtime package |
| Paths are named `repo_*`/`dsh_*` with a `_dir`/`_file` suffix | A name should say which side a path belongs to, and whether it is a directory or a file |
| A failed run is fixed and re-run, never rolled back | Every step is idempotent, so rollback, transactions and an exit-code taxonomy would buy nothing for a dev-loop tool |

## Constraints worth remembering

- `dsh` must be on `PATH` or given as `--dsh <path>`; the tool fails instead of fetching a
  harness on the fly (a `pnpm dlx` bootstrap pulls ~500 packages and dies on pnpm's
  build-script gate).
- The patch layer is copied **in place**: a running profile watches that exact path, and an
  atomic rename would drop the watch.
- Planning must stay cheap: `--dry-run` only prints, and the effects wrappers are the only
  code that reads `dry_run`.
