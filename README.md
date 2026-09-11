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
| `@dsh-external/dotdsh-git-flow` | `git-flow` | The feature-branch workflow for git work: the `/git-start` and `/git-complete` commands, a pre-write guard that opens a branch instead of letting an edit land on the integration branch, a system-prompt contract plus a live state context, a bundled `git-commit` skill (Conventional Commits 1.0.0), and git-worktree isolation for parallel sessions |

## The git-flow workflow

Two slash commands, and one invariant that holds whether or not anyone remembers to use them.

```
/git-start [<name>]   open a feature branch for this session
/git-complete         replay it if the integration branch moved, merge it, remove its worktree, delete it
```

`/git-start` names the branch from what the session is working on — the first line of the opening
prompt, with a leading verb dropped, so "add the login redirect" becomes `feature/login-redirect`.
When the intent yields no name, it **asks** rather than inventing one. That "asks" path covers more
than an empty prompt, and the rule is worth knowing because it is not obvious: the slug rules are a
Latin-script heuristic, so a prompt written in another script is not slugged at all. A
predominantly Chinese prompt that merely *mentions* a Latin word would otherwise name the branch
after that word — observed in practice, where the opening prompt for this very plugin (Chinese, with
`github` in it) produced `feature/github`. A wrong-but-plausible name is worse than a question:
nobody notices it is wrong, and the branch keeps the name long after the session is gone. A Latin
sentence that mentions a foreign word still names a branch (`add support for 中文 filenames` →
`feature/support-filenames`); a non-Latin sentence asks.

`/git-complete` merges with `--no-ff` so the branch point stays
visible in history, and when the integration branch has moved since that branch point it replays
the feature onto the new tip first:

```
git rebase --onto <integration> <merge-base> <branch>
```

That replay is the whole reason this is not just `git merge`: a merge commit whose second parent
never sat on the first is a history that reviewing, bisecting and `git log --first-parent` all get
wrong, and no flag fixes it after the fact. A conflict aborts the replay and reports; nothing is
resolved automatically and nothing is force-pushed.

### The guard

`tools/pre-execute` runs before a tool dispatches and can genuinely stop it, so an edit aimed at the
integration branch opens a feature branch first. When other sessions are live, the arriving session
is **isolated in a worktree** and the write that triggered the start is redirected into it — allowing
that write would defeat the isolation on its first use. Set `guard: block` to always refuse instead,
or `guard: off` to disable it.

Two sessions sharing one checkout is the shape the guard actually has to catch, and it is not the
same question as "are other sessions live". The first session opens a feature branch in that
checkout, so the second no longer sees the integration branch — it sees the first session's branch —
and would write onto it without ever triggering the branch rule. The guard therefore also refuses
when another live session is in *this* working tree, and it decides that by asking git which branch
is really checked out rather than trusting the ledger: a record whose branch is not the one in the
tree is stale, and a stale record must not block a tree nobody is using.

### Parallel sessions and worktrees

When `/git-start` finds another live session that is **not part of its own delegation chain**, this
session is isolated in a worktree under `<repo>/.dsh.local/worktrees/<name>` and its file edits are
required to stay there. Work stays under the repository — never in `$DSH_HOME` — so the harness's
workspace-write sandbox keeps covering it without repeated authorization prompts.

Everything is keyed by the **root** of a session's delegation chain, not by the session itself, and
that is what makes a family behave as one workflow: a subagent runs in its parent's working
directory, so a branch opened for one of them is opened for all of them. Keyed by the immediate
session, whichever of the two wrote first would own the record and the other would see a stranger
and open a *second* branch in the same checkout, moving it out from under the first. Keyed by the
root they share one record and one branch, and a subagent is never handed a worktree of its own —
unless it asks for one by naming a branch explicitly, in which case it is isolated, because
switching the shared checkout would silently repoint its parent's work at a different branch.

The other half of the rule is what a sibling is. Two top-level sessions with one working directory
are the ordinary way to hit this: the first opens a branch there, so the second no longer sees the
integration branch — it sees the first session's branch. Adopting that would put two sessions' work
on one branch, so a branch owned by a stranger is never adopted; the arriving session is isolated
instead.

### `.dsh.local`

Everything this plugin leaves on this machine lives in one ignored directory at the repository
root: the worktrees, and a ledger of the open feature branches (`git-flow.json`). `.dsh.local`
rather than `.dsh` because the harness reads `<project>/.dsh/skills` for *project* skills, which are
meant to be committed and shared — a rule ignoring `.dsh/` would quietly stop a team's skills from
being tracked. A name of its own can be ignored wholesale, and the `.local` half says what it is.

`/git-start` adds `.dsh.local/` to the tracked `.gitignore` with a comment explaining it, and then
**verifies with `git check-ignore`** rather than trusting the write. Two reasons, both silent when
they go wrong:

- A `git worktree` inside the repository is a linked repository, and a `git add --all` from the main
  tree does not stage its thousands of files — it stages **one** entry, a gitlink recording a commit
  id that stops being reachable the moment `/git-complete` deletes the branch. A clone could never
  reproduce it, and this plugin's own per-step commits would commit it for you.
  (`node_src/git-flow/test/verify-ignore.mjs` asserts that failure really happens without the guard,
  so the guard's premise cannot rot unnoticed.)
- The ledger holds **absolute paths belonging to this machine**, and it is written by every start —
  including the single-session one that creates no worktree at all. So the rule is ensured before
  the first state write, not only on the path that creates a worktree.

A rule that another rule overrides — a later `!` line, a parent directory's ignore — makes the
plugin refuse to proceed rather than leave state that only looks protected.

The directory is anchored to the repository's **main** working tree, never to the session's own:
a path resolved from the session's directory would give every linked worktree its own ledger, and
the copy a worktree session reads is exactly the one that cannot tell it another session is already
working here.

### Configuration

Every tunable, at its default, in the row's `config` in `node_src/dotdsh/cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `branchPrefix` | `feature/` | Prefix `/git-start` gives every branch it opens |
| `integrationBranch` | `""` | Empty detects `origin/HEAD`, then `main`, then `master` |
| `worktreeRoot` | `.dsh.local/worktrees` | Relative to the repository's **main** tree; must stay inside it |
| `useWorktreeWhenBusy` | `true` | Isolate a session that arrives while others are live |
| `commitUncommittedBeforeMerge` | `true` | Collect loose work into a commit before merging, instead of blocking |
| `mergeMessage` | `Merge {branch} into {integration}` | Merge-commit subject; `{branch}` must be present |
| `guard` | `auto-start` | `auto-start`, `block`, or `off` |
| `guardBash` | `false` | Extend the guard to the Bash tool — see the caveat below |

Two things the plugin deliberately does not do:

- **It does not guard the Bash tool by default.** `bash` arguments name a command, not a path, so
  enabling it cannot tell `git status` from a redirect and would open a feature branch for every
  shell command a session runs. Turn it on with `guardBash: true` when the Bash tool is how files
  actually get written.
- **It does not commit for you after each step.** The contract is in the system prompt and the
  `git-commit` skill tells the model how to write each message; a commit per *tool call* would be
  noise. `commitUncommittedBeforeMerge` is the safety net that keeps loose work from being stranded
  at `/git-complete`.

The two tweaks are configured per machine rather than in this repository. Their namespace is the
one a browser half can actually read — a client bundle never sees its row's `config` — and the
settings file provider watches its document, so an edit applies without a restart:

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
- `doc/src/todo.md` — what is planned;
- `doc/src/AGENTS.md` — conventions for AI agents working here.

`doc/src/README.md` and `doc/src/AGENTS.md` are symlinks to the root files, not copies:
each page has exactly one source.
