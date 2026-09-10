# TODO

dotdsh is still a skeleton; this file tracks the concrete next steps.

## Framework

- [ ] Publish the packages to npm under `@dsh-external`. The bundle already depends on its
  plugin packages through `workspace:*` (pnpm rewrites that to a real version at pack time),
  so what is left before a first publish is: a `LICENSE` file and a package `README.md` per
  package (neither ships today), and `publishConfig.access: public`. Publishing is also what
  unlocks the single-dependency consumer install (`dsh plugin add @dsh-external/dotdsh`); a
  `file:` or tarball install cannot work before the plugin packages resolve from a registry,
  so verify that shape against a local registry first
- [ ] Decide the final platform name before publishing (`dotdsh` is taken on GitHub; npm is free)
- [ ] Add CI: a clean-tree `pnpm build` + `mdbook build` + `uv run ruff check`. A repository
  check command (rows ↔ packages, and the "no absolute paths in committed files" rule) was
  written and then deliberately dropped while the tool was reduced to `dev_apply`; re-add it
  here when CI exists
- [x] Collapse the tool to one command: `dev_apply` builds, link-installs every `node_src/*`
  package through one `dsh plugin add`, and prints the restart reminder
- [x] Move the plugin rows into the `@dsh-external/dotdsh` bundle, so dsh composes them as a
  layer and nothing has to be copied into a profile
- [x] Stop writing the profile's `cordis.patch.yml`: it is the user's own layer again
- [x] Rename the release script to `pnpm release`: as `publish` it was a lifecycle hook, so
  `pnpm publish --dry-run` really did publish the packages (flags never reached it)
- [x] Run the dev loop against the real `~/.dsh` (verified: the `hello_world` tool answers in
  the running profile)

## Plugins

- [x] Migrate plugin sources to TypeScript (tsc → in-package `lib/`, gitignored; auto-built)
- [x] Fix the stale `hello_world` tool description: it claimed the greeting came from the
  removed plugin store's `applist.yaml`; the plugin now points at its row in the bundle patch
- [ ] Create an SSH plugin for remote-server development: the backend keeps one long-lived SSH
  connection per host (HTTP keep-alive style) instead of logging in per command — auto-connect
  on first use, auto-recycle idle connections on timeout, avoid repeated TCP handshakes and
  re-auth
- [ ] Replace `hello-world` with real plugins (per the original goal: a tool-aggregation
  bundle to de-fragment micro-features). Started: `ui-tweaks` is the first real plugin — and the
  first dual-face one, so it also established the browser-half conventions in
  [Design decisions](./design.md); `hello-world` now earns its place as the node-only example
  until a real node-side plugin replaces it
- [ ] Give a browser half a committed test. The `ui-tweaks` check that proves the boot-protocol
  registration, the manifest contract and every Enter decision against a fake DOM runs from
  gitignored `target/node/`, so a clean checkout has nothing guarding `client/index.js` — and a
  browser half has no `tsc` pass to catch a mistake either

## Home config

- [x] `dsh_home/settings.yaml` mirrors the setup this repository is developed against
  (commented examples only; nothing syncs it, and copying it to `$DSH_HOME` stays a one-time
  manual step)
- [ ] Optional: enable module HMR for the plugin packages by overriding the `hmr` row in the
  **profile user layer** (`{id: hmr, disabled: false, config: {root: ['<repo>/node_src']}}`),
  so a rebuilt `lib/` reloads without a restart. Needs one restart to take effect, and a
  framework-level change still exits the process (dsh implements no restart hook)

## Languages

- [x] Python tooling lives in the uv workspace (`py_src/dev-apply`, run with
  `uv run python -m dev_apply`), and the member has no runtime dependencies
- [x] Python 3.14 is the floor (`requires-python` in both pyproject files, ruff
  `target-version = "py314"`); its default lazy annotations (PEP 649) made
  `from __future__ import annotations` unnecessary, so it is gone
- [x] Dev tooling (ruff lint/format) lives at the workspace root: `[dependency-groups] dev` +
  the single `[tool.ruff]` config, installed by `uv sync`
