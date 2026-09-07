# TODO

dotdsh is still a skeleton; this file tracks the concrete next steps.

## Framework

- [ ] Publish the store package and plugins to npm under `@dsh-external` (switch `link:` deps to registry versions for sharing)
- [ ] Decide the final platform name before publishing (`dotdsh` is taken on GitHub; npm is free)
- [ ] Add CI: run `gen_applist.py` idempotency check + `mdbook build` on every push

## Plugins

- [ ] Replace `hello-world` with real plugins (per the original goal: a tool-aggregation bundle to de-fragment micro-features)
- [ ] Introduce a TypeScript build step when plugins grow; output must go to `target/node`

## Home config

- [ ] Fill in `dsh_home/settings.yaml` and home-level `dsh_home/cordis.patch.yml` with real preferences
- [ ] Run `sync_home.py` against the real `~/.dsh` (so far only verified in temporary homes)

## Languages

- [ ] Add `py_src/` + root `pyproject.toml` when a Python project appears (output to `target/python`)
