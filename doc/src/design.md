# Design decisions

dotdsh is deliberately small: a handful of plugin packages under `node_src/`, one bundle that
carries their patch rows, and one ~50-line command that builds and links them. This page
records why it is shaped that way. The dsh contract itself (bundles, patch layers,
composition order, hot reload) is summarized in [AGENTS.md](./AGENTS.md).

## What this replaced

The first version kept a plugin *store*: an `applist.yaml` inventory, a Python package to load
and validate it, and a generator that turned the inventory into `cordis.patch.yml`. Two
consumers (the install path and the home-config sync) shared the store, which seemed to
justify schema validation, typed models, and a generated-but-committed patch file.

In practice the store, the generator and the "generate but commit" coupling *were* the
complexity budget, and the inventory never held more than a handful of rows. The whole layer
went: rows became hand-written, plugin packages became plain packages, and one script did the
wiring.

That script then grew its own layer, and the same test was applied to it:

1. It rewrote the profile's `package.json` by hand, because `dsh plugin add <path>` was
   believed unusable here. A retest on pnpm 12.3.4 / Node 26 showed every form working
   (`add link:<abs>`, `add <abs>`, `add ./node_src/<id>`, `add .`), so the manifest writer
   went and pnpm took over.
2. It copied the repo's patch file over the profile's user layer, because rows had to reach a
   running profile. A bundle does that better: dsh composes the bundle's patch layer by
   itself, and the profile user layer stays the user's.
3. It grew a `check` command, a dependency plan and a stale-entry prune to keep the
   hand-maintained rows honest. Once each plugin is linked and the single command is
   idempotent, those checks stopped paying for themselves; the validation they did is on the
   [TODO](./todo.md) list for the day CI is set up.

What is left is one command with three steps and no state: build, link, remind.

## Decisions

| Decision | Why |
|---|---|
| One bundle (`node_src/dotdsh`) plus plain plugin packages | This is dsh's own shape: of the 224 `@deepseek-ai` packages installed here, only 6 are bundles (the app/composition packages) and the rest are plain packages mounted by a bundle's rows. The rows stay in one visible file, and nothing has to be injected into a profile by hand |
| Rows are hand-written in the bundle's `cordis.patch.yml` | A handful of rows does not justify a generator, and the file is the layer dsh actually composes |
| `dev_apply` does exactly three things | It is the whole tool: `pnpm -r build`, one `dsh plugin add` covering every `node_src/*` package, and a restart reminder. No plan, no copy, no prune, no state to keep in sync |
| pnpm writes the profile manifest; dsh maintains the layer list | `dsh plugin add link:<absolute path>` is the supported path, and the install plus the `dsh.profile.bundles` reconcile stay in dsh instead of being reimplemented here |
| `link:` for development, `workspace:*` for publishing | `link:` is the only protocol that lets the profile read the repository in place (a `link:` install never materializes the linked package's dependencies, which is why every plugin package is linked individually). `workspace:*` inside the bundle is what a published install needs — pnpm rewrites it to a real version at pack time, while `link:`/`file:` would be shipped verbatim and break for consumers |
| The restart is the user's, not the tool's | The command is normally run from inside the dsh session it would restart (the environment carries `DSH_SESSION_ID`), and dsh implements no self-restart hook: `loader.exit()` is only a "host may restart on full reload" interface. Respawn-plus-port-probe is supervision work, so the tool prints a reminder instead and leaves restarting to tmux, systemd, or your terminal |
| The profile's `cordis.patch.yml` belongs to the user | It is the only layer that hot-reloads and the only place per-profile overrides and disables belong. Nothing in this repository writes it |
| Python tooling is a uv workspace run with `python -m dev_apply` | PEP 723 scripts cannot express a multi-file tool, and one workspace keeps the venv, the lockfile, and the ruff config in one place |
| The workspace root is `package = false` | The root only aggregates the environment; it should not be buildable as a wheel |
| Dev tooling lives in the root dependency group | `uv sync` installs ruff with everything else, and the member stays a plain runtime package with no dependencies |
| Paths are named `repo_*`/`dsh_*` with a `_dir`/`_file` suffix | A name should say which side a path belongs to, and whether it is a directory or a file |
| A failed run is fixed and re-run, never rolled back | Every step is idempotent — `pnpm -r build` and `dsh plugin add` both converge — so rollback and transactions would buy nothing |
| Browser-side tweaks share one dual-face package (`node_src/ui-tweaks`) | Small behaviour changes are cheap to write and expensive to fragment: a package per tweak multiplies rows, manifests and lockfile importers for twenty lines of code. One package owns a `tweaks` registry, each entry a reversible `install()`. The shape is dsh's own: a `dsh.client` declaration plus a browser half at `exports["./client"]`, exactly like the `dsh-client-ui-*` packages |

## The browser half

A dual-face package is mounted like any other — its row names the package and the Loader imports
the node half — but the node half may be an empty `apply()`: being an *active Loader entry* is
what makes dsh's client-modules scan find the package, read its `dsh.client` declaration, resolve
`exports["./client"]` and add that file to the browser boot graph as one cordis entry.

Two consequences shape `node_src/ui-tweaks`:

1. **The browser half is hand-authored and committed.** dsh serves those exact bytes as a classic
   script that must register itself through the boot protocol
   (`window.__ModuleLoader__.load({id, factory})`, `id` = the package name), so the file cannot
   live under gitignored `lib/`, and dsh fails the boot when it is missing. It needs no bundler
   because it is plain JavaScript with no imports and no JSX — which is also why the package
   declares no `dsh.client.inject`.
2. **No row config reaches the browser.** The boot graph carries
   `id`/`url`/`rev`/`inject`/`external`/`immediately` and nothing else, so a tweak cannot read its
   row's `config`. Tweaks are therefore enabled by the package's presence and turned off per
   profile in that profile's own `cordis.patch.yml` (`- {id: ui-tweaks, disabled: true}`).

The first tweak also records how far a plugin can go without a harness extension point: the
composer's Enter gesture is a hardcoded Lexical command registered at CRITICAL priority by
`dsh-client-ui-conversation`, with no keybinding registry to hook and no editor handle a plugin
can reach. The tweak therefore intercepts `keydown` in the capture phase ahead of Lexical's root
listener and replays the bare Enter it claims as `Shift+Enter` — the one chord the shipped keymap
deliberately passes through to Lexical's plain-text default, which inserts a real line break
(serialized to the model as `"\n"`). Every other chord, and the suggestion-menu Enter, keeps its
shipped meaning.

## Constraints worth remembering

- `dsh` must be on `PATH` or given as `--dsh <path>`; the tool fails instead of fetching a
  harness on the fly (a `pnpm dlx` bootstrap pulls ~500 packages and dies on pnpm's
  build-script gate).
- **Bundle layers are read at boot.** Only the profile and home `cordis.patch.yml` layers
  hot-reload, so a plugin-code change, a row change, and adding or removing a package all
  need a dsh restart. A config experiment that must be live belongs in the user layer.
- **Repository files never contain absolute paths.** Machine-local paths — the `link:` specs
  in the profile manifest, an HMR `root` — live in `$DSH_HOME` layers only, and `dev_apply`
  computes them at run time. `workspace:*` is how the repository refers to its own packages.
- **A browser half is source, not build output.** `pnpm -r build` compiles `src/*.ts` into
  gitignored `lib/`, but `client/index.js` is committed: the client-modules scan serves those
  bytes (a missing bundle fails the boot) and dsh's HMR can only rebuild what a bundler watched.
  Editing it therefore needs a dsh restart, like every other change on the boot path.
- A workspace package with **no dependencies at all** gets no `pnpm-lock.yaml` importer entry,
  and `pnpm install --frozen-lockfile` then fails with `ERR_PNPM_PACKAGE_MANAGER_NO_IMPORTER`
  (pnpm 12.3.4 writes no empty importer and refuses to invent one). That is why the bundle
  declares its plugin packages and every plugin package declares its harness peers.
- **Installing only the bundle is the consumer shape, and it needs published packages.** A
  `file:` install of `node_src/dotdsh` fails with "`@dsh-external/dotdsh-hello-world@workspace:*`
  is in the dependencies but no package named … is present in the workspace"; a tarball from
  `pnpm pack` (which rewrites `workspace:*` to `0.1.0`) fails with a registry 404, and pnpm
  refuses `bundledDependencies` under its default linker, so nothing can embed the plugin
  packages yet. Until the packages are published, the profile keeps one `link:` per package —
  which is also what makes live editing work.
- `publish` is an npm lifecycle-hook name, so a script called `publish` runs *as part of*
  `pnpm publish` and the command's own flags never reach it — `pnpm publish --dry-run` would
  still have published every package. The release script is therefore named `release`.
