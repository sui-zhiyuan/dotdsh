# TODO

dotdsh is still a skeleton; this file tracks the concrete next steps.

## Framework

- [ ] Publish the plugins to npm under `@dsh-external` (switch `link:` deps to registry versions for sharing)
- [ ] Decide the final platform name before publishing (`dotdsh` is taken on GitHub; npm is free)
- [ ] Add CI: clean-tree `pnpm build` check + `mdbook build` on every push

## Plugins

- [x] Migrate plugin sources to TypeScript (tsc → in-package `lib/`, gitignored; auto-built by dotdsh_dev/prepublishOnly)
- [x] Collapse the applist/store/generator flow into a single hand-maintained root `cordis.patch.yml` + the `dotdsh_dev` dev-loop script
- [ ] Create an SSH plugin for remote-server development: the backend keeps one long-lived SSH connection per host (HTTP keep-alive style) instead of logging in per command — auto-connect on first use, auto-recycle idle connections on timeout, avoid repeated TCP handshakes and re-auth
- [ ] Replace `hello-world` with real plugins (per the original goal: a tool-aggregation bundle to de-fragment micro-features)

## Home config

- [ ] Fill in `dsh_home/settings.yaml` with real preferences and copy it to `$DSH_HOME` once (nothing syncs it automatically)

## Languages

- [x] Python tooling lives in the uv workspace (`py_src/dotdsh-dev`, run with `uv run python -m dotdsh_dev`)
