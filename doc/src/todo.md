# TODO

dotdsh is still a skeleton; this file tracks the concrete next steps.

## Framework

- [ ] Publish the store package and plugins to npm under `@dsh-external` (switch `link:` deps to registry versions for sharing)
- [ ] Decide the final platform name before publishing (`dotdsh` is taken on GitHub; npm is free)
- [ ] Add CI: run `gen_applist.py` idempotency check + `mdbook build` on every push

## Plugins

- [x] Migrate plugin sources to TypeScript (tsc → in-package `lib/`, gitignored; auto-built by sync/prepublishOnly; on `feature/typescript`)
- [ ] Add a CI clean-build check (lib/ is untracked, so CI must verify `pnpm build` passes on a clean tree)
- [ ] Create an SSH plugin for remote-server development: keep one long-lived SSH connection per host on the backend (HTTP keep-alive style) — auto-connect on first use, auto-recycle idle connections on timeout, avoid per-command TCP handshakes and re-auth
- [ ] Replace `hello-world` with real plugins (per the original goal: a tool-aggregation bundle to de-fragment micro-features)

## Home config

- [ ] Fill in `dsh_home/settings.yaml` and home-level `dsh_home/cordis.patch.yml` with real preferences
- [ ] Run `sync_home.py` against the real `~/.dsh` (so far only verified in temporary homes)

## Languages

- [ ] Add `py_src/` + root `pyproject.toml` when a Python project appears (output to `target/python`)
