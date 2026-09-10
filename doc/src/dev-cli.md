# The `dotdsh_dev` CLI

`uv run python -m dotdsh_dev` wires this repository into a dsh profile: it builds the
plugin packages, link-installs them into the profile, and copies the root patch layer
onto the profile's user layer. Plugin rows reach a running profile by hot reload; new
plugin code needs a dsh restart.

## Steps, in order

1. **build** — `pnpm -r build` in the repo root (skipped with `--no-build`).
2. **manifest** — rewrite the profile `package.json` `dependencies`: one
   `link:<absolute path>` entry per `node_src/<id>/`, and stale `link:` entries that
   point into this repository but match no package are dropped.
3. **install** — `dsh plugin --profile <name> install`, which forwards `pnpm install`
   in the profile directory and reconciles `dsh.profile.bundles`.
4. **patch** — copy the root `cordis.patch.yml` verbatim over the profile's user layer,
   **in place**: the profile's HMR watcher holds an exact-path watch on that file, and
   an atomic rename would lose it.

## Failure model

Every step is idempotent and nothing is rolled back: when a step fails, fix its cause
and re-run the whole sync — a re-run converges. The patch layer is copied last on
purpose, so a failed build or install leaves the running profile's patch layer as it
was. The CLI reports one line per failure and exits 1; `--traceback` restores the full
stack, and a corrupt profile manifest is reported as a message rather than a traceback.

## Modules and the two invariants

| File | Role |
|---|---|
| `constants.py` | `BIN_NAME`, `PATCH_FILENAME`, `ROOT_MARKERS` |
| `context.py` | `UserError`, `log_line`, `Context` (+ `verify()`) |
| `effects.py` | `run_cmd`, `copy_file`, `write_file` — the only readers of `dry_run` |
| `__init__.py` | `Plugin`, `list_plugins`, `plan_link_deps`, `dev_sync` + re-exports |
| `__main__.py` | CLI: `parse_args`, `resolve_*`, error reporting, `main` |

- **One dry-run boundary.** Under `--dry-run` each effect logs `[dry-run] <module>:
  would ...` and returns; no other module branches on `dry_run`. Every step is written
  once and behaves the same in both modes.
- **One validation point.** `Context.verify()` checks that the context is complete and
  that every path exists, and `main` calls it before `node_src` is scanned. Command
  availability is checked when a command is actually run, which keeps `--dry-run` free
  of tool requirements — printing a plan needs neither pnpm nor dsh.

## Logging

Steps report through `ctx.log(module, level, message)`:

- `module` — which step: `sync`, `build`, `manifest`, `install`, `patch`, `dsh`
- `level` — `info`, `plan` (the same step under `--dry-run`), `error`
- `message` — the human text

`--dry-run` and a real run therefore print the same sequence of steps, differing only
in `would ...` versus the past tense. The default logger flushes every line, so a child
process cannot overtake it in captured output.

## Naming

`repo_*` for this repository, `dsh_*` for `$DSH_HOME` configuration; path names end in
`_dir` or `_file`. Parsed data keeps the ownership prefix: `dsh_manifest_file` is the
path, `dsh_manifest` is the JSON read from it. [AGENTS.md](./AGENTS.md) states the
convention in full.

## Environment constraints

- `dsh plugin add <path>` cannot be used here: pnpm 12 on Node 26 parses directory
  arguments as registry names. `dotdsh_dev` writes `link:` dependencies and calls
  `dsh plugin install` instead.
- The workspace-dependencies precondition is `node_modules/` plus `pnpm-lock.yaml`;
  probing pnpm's internal `.pnpm` layout produced false negatives.
- [AGENTS.md](./AGENTS.md) documents how to verify a sync against a temporary
  `DSH_HOME` with a stub `dsh`, without touching the real `~/.dsh`.
