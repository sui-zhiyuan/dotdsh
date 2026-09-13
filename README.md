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
| `@dsh-external/dotdsh-git-flow` | `git-flow` | The feature-branch workflow for git work: the `/git-start`, `/git-complete` and `/git-cleanup` commands and the matching `git_start`, `git_complete` and `git_cleanup` tools, a pre-write guard that opens a branch instead of letting an edit land on `master`, a per-family **claim** recording which working tree a session writes in, and two bundled skills — `git-flow` (where a session may write) and `git-master` (Conventional Commits 1.0.0) |

## The git-flow workflow

Everything the workflow does is reachable twice: as a slash command for a human, and as a tool for the
model.

```
/git-start [<name>]    open a feature branch for this session
/git-complete [<msg>]  merge with --no-ff, release its tree, delete it; report not-descendant when master moved, for the model to replay
/git-cleanup           reclaim the branches and trees sessions that can no longer come back left behind
```

The commands inject one plugin-sourced notice where they need the model to finish the job — `/git-start`
with no name, `/git-complete` with no message — and the tools never inject anything, because a tool call
*is* the model acting and its return value is the whole answer.

**Naming.** A feature is named by the human or the model, never guessed from a prompt: `/git-start add
a login redirect` takes `add` as the entire name and refuses it, and `git_start` declares `branchName`
as a required argument, so a model that cannot name the feature asks instead of inventing one. What a
name may be is deliberately narrow — a subject: letters, digits and dashes, starting with a letter, at
most 20 characters. `feat/` is added by the plugin, not by the caller: `git-flow-guard` opens
`feat/git-flow-guard`, and a name that brings its own namespace, like `test/git-flow-guard`, is refused
rather than doubled into `feat/test/git-flow-guard`.

**Finishing.** `/git-complete` merges with `--no-ff` so the branch point stays visible in history. When
`master` has moved past the branch point, merging would bury the replay inside the merge commit, so
nothing is written: the call reports `not-descendant` and the model replays the branch by hand —

```
git rebase --onto master $(git merge-base master <branch>) <branch>
```

— then calls again. Nothing is resolved automatically and nothing is force-pushed.

### The guard

`tools/pre-execute` runs before a tool dispatches and can genuinely stop it. A file-writing call from a
session with no claim is refused, and the refusal names the `git-flow` skill and the `git_start` call to
make: because the plugin never guesses a feature name, the one useful thing it can hand over at that
moment is the rule. Once a claim exists, the guard's whole question is whether the declared path is
inside the tree that claim names — the repository's main checkout for the family that holds it, its own
worktree for a family that had to move out.

The guard reads the path a tool *declares*, which is the first of its limits: a write reached through a
shell command is not seen. It also ignores a call that carries no agent, and it never answers `ask` —
its reader is the model, never a human.

### Parallel sessions and trees

A repository's main checkout is a resource, and the first family gets it: a start in a repository whose
main tree nobody holds checks the branch out **in place**, and creates nothing else. A family that
arrives while another **resumable** family holds the main tree is isolated in a worktree under
`<repo>/.dsh.local/worktrees/<name>`, and its edits are required to stay there. Work stays under the
repository — never in `$DSH_HOME` — so the harness's workspace-write sandbox keeps covering it without
repeated authorization prompts.

Every decision is keyed by the **root** of a session's delegation chain, not by the session itself, and
that is what makes a family behave as one workflow: a subagent runs in its parent's working directory,
so the branch and the tree opened for one of them are opened for all of them. Keyed by the immediate
session, whichever of the two wrote first would own the record and the other would see a stranger and
start a *second* branch in the same checkout, moving it out from under the first.

"Resumable" is the other half of the rule: a claim whose session can no longer come back is a leftover
for `/git-cleanup`, not a reason to exile the next session to a worktree — so the main tree reads as
free the moment nobody is coming back for it.

### `.dsh.local`

Everything this plugin leaves on this machine lives in one directory at the repository root: the
worktrees, and the claim file `<repo>/.dsh.local/git-flow.toml`. `.dsh.local` rather than `.dsh`
because the harness reads `<project>/.dsh/skills` for *project* skills, which are meant to be committed
and shared; the `.local` half says what this is: this machine's, not the repository's.

The claim file is a small TOML document: a version stamp and one row per family, keyed by the root
session id, naming the branch and the tree. A row whose `worktreeName` is `[MAIN]` says the family works
in the repository's own checkout — the brackets are what make that name unoccupiable, since a real
worktree's directory name is built from a branch subject. Its paths are absolute and machine-local, and
the file's first lines say so.

**The plugin does not add an ignore rule for it, and does not check one.** That rule is a one-time
addition per repository, made by hand. What the plugin guarantees instead is narrower: its own commands
never stage anything — `/git-complete` merges, and a merge cannot carry the claim file into history. A
careless `git add --all` typed by a human still can, which is why the file opens with what it is.

The directory is anchored to the repository's **main** working tree, never to the session's own: a path
resolved from a session's directory would give every worktree its own claim file, and the copy a
worktree session reads is exactly the one that cannot tell it another session is already working here.

### Configuration

There is none. The rewrite hardcodes what the previous implementation configured — the `feat/` prefix,
`master` as the integration branch, `.dsh.local/` for state — because a terminal workflow for one
repository does not need a schema, and the row's `config` is read by nothing. Two things it deliberately
does not do:

- **It does not guard the Bash tool.** `bash` arguments name a command, not a path, so a guard over them
  cannot tell `git status` from a redirect. Write files with the file tools.
- **It does not commit for you after each step.** The `git-flow` skill says to commit per completed step
  and the `git-master` skill says how to write the message; a commit per *tool call* would be noise.

The ui-tweaks settings, by contrast, are configured per machine rather than in this repository. Their
namespace is the one a browser half can actually read — a client bundle never sees its row's `config` —
and the settings file provider watches its document, so an edit applies without a restart:

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
- `doc/src/git-flow-multi-session.md` — the claim design as it was argued before the rewrite, kept as
  the record of the reasoning;
- `doc/src/todo.md` — what is planned;
- `doc/src/AGENTS.md` — conventions for AI agents working here.

`doc/src/README.md` and `doc/src/AGENTS.md` are symlinks to the root files, not copies:
each page has exactly one source.
