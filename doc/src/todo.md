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
- [x] Give a browser half a committed test. It ran from gitignored `target/node/`, so a clean
  checkout had nothing guarding `client/index.js` — and a browser half has no `tsc` pass to catch
  a mistake either. It now lives at `node_src/ui-tweaks/test/verify-client.mjs` (run by `pnpm test`),
  locates its package from its own path instead of counting up from `target/`, keeps to Node
  built-ins (no dependency, no harness, no network), and states in its header what a green run does
  not prove: the sandbox has no React, no Lexical and no locale service, so end-to-end behaviour is
  still settled by loading the page once
- [x] Make the status wording configurable. `STATUS_PHRASES` was a hardcoded bank in
  `ui-tweaks/client/index.js`, and a browser half cannot read its row's `config` (the boot graph
  carries none — see [Design decisions](./design.md)), so per-machine wording needed a source the
  half could actually reach. It took the first of the two candidates: the `ui-tweaks` settings
  namespace, registered by the node half and read through `ctx.settingsScope` in the browser — the
  channel every shipped browser preference already uses. The bank stays the shipped half and
  `statusPhrases` is appended to it; the same namespace carries the two switches
  (`composerEnterNewline`, `statusWording`). A page-local source (a query parameter,
  `localStorage`) was the alternative and is still the fallback if a switch must work on a page
  with no settings transport
- [x] Give a node half a committed test too. `verify-host.mjs` (also run by `pnpm test`) pins what
  `tsc` cannot: the namespace and schema that the browser half binds and reads by name, the `base`
  layer carrying the row's config, the serialized wire schema, and the no-provider degrade. The
  namespace and field-name agreement it checks against `client/index.js` is a name-level check —
  what the page does with an adopted section stays the browser half's own check, and whether dsh
  resolves and persists a section is settled by loading the page once
- [x] Build the git workflow as one node-only plugin (`node_src/git-flow`): `/git-start` and
  `/git-complete`, the `tools/pre-execute` branch guard, the system-prompt contract and state
  context, a bundled `git-commit` skill, and worktree isolation for parallel sessions. Two
  committed checks cover the parts that fail silently — the ignore guard (including an assertion
  that git *does* stage a gitlink without it, so the premise cannot rot) and the merge semantics
  (asserting the rebase really happened, by reading the parents of the resulting merge commit back
  out of git). Design rationale in [Design decisions](./design.md)
- [ ] **Isolate a second sibling session instead of adopting the first one's branch.** Found by
  running the flow twice against one scratch repository: session A starts in place (so the shared
  main tree is on `feature/a`), then session B runs `/git-start` — and B sees "already on a feature
  branch", takes the adoption path, and joins A's branch with no worktree. Requirement 8 fails in
  the most ordinary concurrency case, and B's writes are then refused by the guard with advice
  (`/git-start`) that leads straight back to the adoption path. The same over-broad rule denies a
  *subagent* every write while its parent has a branch, because a subagent shares the parent's
  checkout. Both want one missing distinction: family versus stranger. `SessionHeader` carries what
  it takes — `parentSession`, `origin: 'subagent'`, `delegationDepth` — so a record should carry its
  owner's `parentSession`, and a session should treat a claimant in its own ancestry as family
  (adopt, and allow the write) and anyone else as a stranger (isolate in a worktree, and refuse the
  write in a checkout they own)
- [ ] Let the model open a feature branch. `/git-start` is a human command, so when the guard
  refuses — the parallel-session case, where it will not pick a branch over another session's work
  — the model can only ask the human to type it. A `git_start` tool would close that gap; it needs
  its own decision about naming (who chooses the name when the model calls it) because the whole
  value of the deny path is that a branch is not opened on a guess
- [ ] Decide whether stacked feature branches should be replayed. `/git-complete` replays the branch
  being finished, with `--onto` and an explicit upstream so only that branch's own commits move. A
  branch cut *from* another feature is detected by nothing today: after its parent merges, its
  branch point is stale and it will be replayed on the next `/git-complete` — but the human is not
  told that this is why
- [ ] Reconsider a `commit-msg` hook alongside the skill. The skill shapes the message before it is
  written, which is the right instrument for a convention; a hook is the right one for a rule a
  human must not be able to talk past (a missing `Refs:` on a repo that requires one). Adding it
  means an installer, because `.git/hooks` is unversioned
- [ ] Record multi-session liveness authoritatively. The ledger judges a session by whether its
  owning *process* is alive, which is wrong in both directions: two sessions share one harness
  process (a closed session keeps its record, so new sessions get an unneeded worktree), and a
  restart kills every pid at once (sessions that are still open read as dead — see the note in
  [Design decisions](./design.md) for why an abandoned branch is therefore reported rather than
  stored). The harness's own session registry would answer the real question; the ledger is the
  fallback that needs no service. Worth doing when a second use for the ledger appears, since the
  current error is bounded in one direction and merely noisy in the other

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
