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
| The git workflow is one node-only package (`node_src/git-flow`) using existing seams, not a new service | It needs no browser half and no service of its own: commands, a prompt section, a skill provider and the `tools/pre-execute` waterfall are all extension points dsh already ships, and each is registered on the seam the harness's own packages use. What it does own is the git logic behind two injectable seams (`Runner`, `FileAccess`), which is what lets the committed tests drive the whole branch/rebase/merge/worktree lifecycle against a scratch repository with no harness present |
| The pre-write guard opens a branch; it never redirects the write | `PreToolDecision` has exactly `allow`/`deny`/`ask` and `exec.arguments` is deep-frozen before any listener runs, so a gate cannot rewrite a path. The denial text therefore carries the correction, and the only automatic action available is a side effect the guard performs itself |

## The browser half

A dual-face package is mounted like any other — its row names the package and the Loader imports
the node half — but the node half may be an empty `apply()`: being an *active Loader entry* is
what makes dsh's client-modules scan find the package, read its `dsh.client` declaration, resolve
`exports["./client"]` and add that file to the browser boot graph as one cordis entry.

Three consequences shape `node_src/ui-tweaks`:

1. **The browser half is hand-authored and committed.** dsh serves those exact bytes as a classic
   script that must register itself through the boot protocol
   (`window.__ModuleLoader__.load({id, factory})`, `id` = the package name), so the file cannot
   live under gitignored `lib/`, and dsh fails the boot when it is missing. It needs no bundler
   because it is plain JavaScript with no imports and no JSX — which is also why the package
   declares no `dsh.client.inject`.
2. **No row config reaches the browser.** The boot graph carries
   `id`/`url`/`rev`/`inject`/`external`/`immediately` and nothing else, so the browser half cannot
   read its row's `config`. Mounting the package is what enables the tweak set, and the whole set
   is turned off per profile in that profile's own `cordis.patch.yml`
   (`- {id: ui-tweaks, disabled: true}`).
3. **A settings namespace is the channel that does reach a page.** Every browser preference the
   Web app ships travels this way: the package's node half registers a namespace with a schemastery
   schema, and its browser half reads the resolved section through `ctx.settingsScope` — ui-chat,
   ui-conversation and ui-theme all do exactly this. ui-tweaks follows it, so its three switches
   are per machine and live rather than baked into the repository:
   `ctx.inject(["settings"], …)` in the node half registers `ui-tweaks` with the row's config as
   the composition `base` layer, `$DSH_HOME/settings.yaml` is the user layer over it, and the file
   provider's watcher republishes an edit without a restart. Both halves therefore carry the same
   three defaults — the node half's schema declares them and the browser half seeds its `settings`
   object with them — which is what a page runs on until the first accepted section arrives, and
   forever in a composition with no settings provider. Two deliberate choices follow from the
   tweak set being independent of the settings domain: the browser half reaches the scope through
   `ctx.inject(["settingsScope"], …)` rather than declaring it in `exports.inject`, so an absent
   settings transport cannot park the tweak set; and each tweak keeps running while switched off,
   forwarding to the shipped behaviour instead of being uninstalled and re-installed on a toggle.

The first tweak also records how far a plugin can go without a harness extension point: the
composer's Enter gesture is a hardcoded Lexical command registered at CRITICAL priority by
`dsh-client-ui-conversation`, with no keybinding registry to hook and no editor handle a plugin
can reach. The tweak therefore intercepts `keydown` in the capture phase ahead of Lexical's root
listener and replays the bare Enter it claims as `Shift+Enter` — the one chord the shipped keymap
deliberately passes through to Lexical's plain-text default, which inserts a real line break
(serialized to the model as `"\n"`). Every other chord, and the suggestion-menu Enter, keeps its
shipped meaning.

The second tweak reaches shipped **copy** rather than a gesture, and it records the one extension
point that exists for that. The running-turn line above the composer is `dsh-client-ui-chat`'s
`TurnStatus` printing `t("chat.deepDiving")` from inside its view component: no slot can replace it,
and `locale.register("chat", …)` cannot reword it either — the registry throws for a namespace and
locale another plugin already owns, and winning that race instead would break ui-chat's own
registration. What is reachable is the *seat*: every `t()` a slot component receives resolves through
`LocaleRuntime.bind(ns)`, an arrow that reads `this.translate(ns, key, params)` at call time. One own
property on the locale service instance therefore intercepts every seat, and `delete` restores the
prototype method exactly — a copy-level hook with no DOM and no hashed class names, where the
ecosystem's equivalent plugins rewrite the `role="status"` text node under a MutationObserver and pay
for it in reconciliation fights and per-release churn. Two details came out of the wording feature.
The locale guard must be read per call (`getSnapshot().active`), because the same seat also serves the
English dictionary and every other chat string. And the re-draw must be gap-driven, because that line
re-renders about once a second while a turn runs: drawing per call would cycle the whole list once a
second, and drawing once at install would freeze it for the life of the page. `translate` is absent
from the locale service's published face, so the wrapper probes for it and degrades to the shipped
wording rather than throwing if a future dsh renames it. The settings section extends that bank
rather than replacing it — `statusPhrases` is appended to the shipped list, resolved at draw time,
so a per-machine phrase joins the memes and an edit applies from the next run on.

## The git-flow plugin

Four decisions in `node_src/git-flow` are worth recording, because each one had a plausible
alternative that turned out to be wrong on this harness rather than merely different.

**The interception seam is narrower than it looks.** `tools/pre-execute` can allow, deny or ask —
and that is all. Argument rewriting does not exist as a decision variant, `exec.arguments` is
deep-frozen before the first listener runs (so that what was logged and what ran cannot diverge),
and the README states the exclusion as deliberate. A guard therefore cannot redirect a write to a
different path; it either lets the call through or refuses it. That is what made the guard's job
"open the branch, then allow" rather than "rewrite the target", and it is why every denial message
carries the correction: the message is the only channel back to the model. It also settled the
seam choice — `ctx.tools.guard` is the synchronous alternative, and deciding this requires asking
git a question.

**Git runs from `ctx.subprocess` with an exact argv, not from `ctx.shell` with a command string.**
`ctx.shell` is the higher-level seam and can apply a sandbox confine, which makes it the obvious
first choice. But it takes a command *string*, so using it would mean quoting a branch name, a path
and a commit message by hand — reintroducing exactly the class of bug that passing every argument as
its own argv element makes impossible. The trade is stated where it is made: this plugin chooses
argv-exactness and does not confine its git children. Every dsh consumer package goes through a
seam; only the provider layer imports `node:child_process`, and the committed tests use that direct
runner so a clean checkout can run them with no harness and no profile.

**The `.gitignore` write does not go through `ctx.fs` either, for a related reason.** Routing it
through `ctx.fs` would fence one file write while the git subprocesses that do the bulk of this
plugin's file mutation stay unconfined — an inconsistency rather than a boundary. It would also be a
hazard: `dsh-fs-sandbox` falls back to the *deployment* policy when no session policy is passed, so
the write would be refused under a policy the session itself is not under. `FileAccess` stays a
seam, so the decision is reversible in one place.

**Two worktree locations, chosen for two different lifetimes.** A *session's* worktree lives at
`<repo>/.dsh/worktrees/<name>`, inside the repository on purpose: the harness's workspace-write
sandbox is rooted at the session's workspace, so work that stays under the repository needs no
re-approval, and `$DSH_HOME` would put it outside that root. The *transient* worktree used to merge
into an integration branch nobody has checked out goes to the OS temporary directory instead — it
exists for seconds, no agent ever edits in it, and keeping it out of the repository means
`/git-complete` never has to rewrite `.gitignore` and never leaves an unignored linked repository
behind if the process dies mid-merge.

**A guess is worse than a question, and the first version of the naming proved it.** Branch names
come from the session's opening prompt, and the slug rules — lowercase, hyphenate, drop a leading
verb, keep a few words — are an English heuristic. Applied to a prompt in another script they do not
degrade gracefully: run against the opening prompt for this very plugin (Chinese, and mentioning
`github` once), they produced `feature/github`. Nothing failed, which is the problem — the branch was
created, the write was allowed, and a meaningless name had joined the repository. The naming now
first asks which script the sentence is written in and refuses to name a non-Latin one, leaving the
human to answer in one word. The check covering it lives in
`node_src/git-flow/test/verify-guard.mjs` and uses that exact prompt, because the case is only
interesting while it is the real one. The same probe is why the guard has a committed check at all:
the guard is this plugin's only *enforcement* point — everything else is prompt text the model may or
may not follow — and until then it was verified by a human remembering to try it.

**"Another session is running" is a proxy, and it is worth being explicit about which one.** The
plugin keeps a per-clone ledger of open branches and asks whether the owning process is still alive.
That is not the same question as "is another session executing right now", and the difference matters
in both directions:

- An **idle** session — one that has stopped and is waiting for its human — counts as present. That
  is deliberate: idle is not finished, its branch is unmerged, and it can resume mid-turn and write.
  Treating it as gone would reintroduce exactly the collision a worktree exists to prevent.
- A session that **closed while its process lives** keeps its record, because two sessions can share
  one harness process and a pid cannot separate them. The cost is a phantom neighbour: new sessions
  in that repository get a worktree they did not strictly need. Bounded and harmless.
- A **restart** kills every recorded pid at once, so sessions that are still open read as dead. This
  is why an abandoned branch is *reported* at the moment its record is dropped rather than stored as
  durable state: a persisted "abandoned" flag would be wrong after every restart. The authoritative
  fix is the harness's own session registry, which is on the [TODO](./todo.md) list.

The one thing the ledger must not do is silently forget. A dead session's record is dropped — it
cannot be resumed — but if its branch still exists, that branch is unmerged work, and `/git-start`
says so. Deleting the record and the fact together is how work goes missing in a repository.

Two smaller choices follow from the same "use the seam the harness uses" rule. The commit-message
convention ships as a **bundled skill provider** — the shape `dsh-skill-badge` establishes, with the
body read from a packaged asset through a `new URL(..., import.meta.url)` locator — rather than as a
`pre-commit` hook, which is unversioned, needs installing per clone, and can only reject a message
after it has been composed. And the per-session ledger lives in
`<git-common-dir>/dsh-git-flow/state.json` rather than in the working tree: it is per-clone (the
right scope for machine-local worktree paths) and it is never staged, so neither this plugin's own
per-step commits nor another session's `git add --all` can sweep it into history — which keeps the
ignore guard's job down to exactly one explainable rule.

## Constraints worth remembering

- `dsh` must be on `PATH` or given as `--dsh <path>`; the tool fails instead of fetching a
  harness on the fly (a `pnpm dlx` bootstrap pulls ~500 packages and dies on pnpm's
  build-script gate).
- **Bundle layers are read at boot.** Only the profile and home `cordis.patch.yml` layers
  hot-reload, so a plugin-code change, a row change, and adding or removing a package all
  need a dsh restart. A config experiment that must be live belongs in the user layer — or, for a
  browser-facing switch, in `$DSH_HOME/settings.yaml`, which the settings file provider watches:
  the `ui-tweaks` switches are that path's worked example.
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
