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
| `@dsh-external/dotdsh-ui-tweaks` | `ui-tweaks` | One home for small browser-side behaviour changes, so each tweak does not become its own package. Today: `composer-enter-newline` — bare <kbd>Enter</kbd> breaks the line in the composer, <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> sends; `llm-status-wording` — while a turn runs, the Chinese status line above the composer shows a randomly drawn DeepSeek-meme phrase; `open-in-editor` — <kbd>Ctrl</kbd>/<kbd>⌘</kbd>+click on a file in the produced-files row or the sidebar tree opens it in the configured editor (VS Code by default, at the clicked line when the surface knows one). All are switchable per machine, and the phrase bank is extendable, through the `ui-tweaks` settings namespace (`$DSH_HOME/settings.yaml`): `composerEnterNewline`, `statusWording`, `statusPhrases`, `openInVscode`, `editorCommand` |
| `@dsh-external/dotdsh-git-flow` | `git-flow` | The feature-branch workflow for git work: the `/git-start`, `/git-complete` and `/git-cleanup` commands and the matching `git_start`, `git_complete` and `git_cleanup` tools, a pre-write guard that refuses an edit landing outside the tree the session's family claimed, a per-family **claim** recording which working tree a session writes in, and two bundled skills — `git-flow` (where a session may write) and `git-master` (Conventional Commits 1.0.0) |
| `@dsh-external/dotdsh-lazy-ssh` | `lazy-ssh` | Remote commands through one `ssh_run` tool, over OpenSSH's own multiplexing: one connection per server is kept open until it has been idle long enough to be worth closing, so a burst of calls pays the TCP handshake and the key exchange once. Authentication stays entirely in `~/.ssh`; the plugin reads, writes and passes no credential |

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
most `branchSubjectMaxLength` characters (20 by default). The configured prefix (`feat/` by default) is
added by the plugin, not by the caller: `git-flow-guard` opens `feat/git-flow-guard`, and a name that
brings its own namespace, like `test/git-flow-guard`, is refused rather than doubled into
`feat/test/git-flow-guard`.

**Finishing.** `/git-complete` merges with `--no-ff` so the branch point stays visible in history. When
the integration branch has moved past the branch point, merging would bury the replay inside the merge
commit, so nothing is written: the call reports `not-descendant` and the model replays the branch by
hand —

```
git rebase --onto <integration> $(git merge-base <integration> <branch>) <branch>
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

Eight keys, all of them optional, read from the plugin's row (`config:` in the bundle patch, or a
profile's own layer) and validated when the plugin mounts: a `branchPrefix` git would refuse, a
`worktreeRoot` that escapes the repository, or a bound that cannot work fails the row rather than the
first operation that trips over it. The defaults are what this repository runs:

| Key | Default | What it decides |
| --- | --- | --- |
| `branchPrefix` | `feat/` | the namespace every family branch carries, and the part stripped to name a worktree |
| `integrationBranch` | `master` | the branch a feature is cut from and merged back into |
| `worktreeRoot` | `.dsh.local/worktrees` | where an isolated family's worktree is created |
| `claimFile` | `.dsh.local/git-flow.toml` | the ledger, and the lock that guards it (`<claimFile>.lock`) |
| `lockStaleSeconds` | `10` | how old the claim lock may be before another process takes it over |
| `sweepAgeHours` | `24` | how old a claim must be before `/git-cleanup` collects it |
| `branchSubjectMaxLength` | `20` | the longest a feature name may be, after the prefix |
| `guard` | `on` | `off` turns the pre-write guard into a pass-through |

The two skills are rendered from those same settings, so a model reads the rules this deployment
actually applies rather than the defaults baked into an asset. Two things the plugin deliberately does
not do:

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
  openInVscode: true              # Ctrl/Cmd+click a file opens it in the editor below
  editorCommand: code             # ONE bare PATH name or ONE absolute executable; no arguments
```

`openInVscode`/`editorCommand` are the two switches the PAGE does not read: opening an editor needs a
process, so the package's node half serves two routes under `/ui-tweaks/open-in-vscode/` and the page
asks them. The host reads both fields per request, so an edit applies to the next click.

Unset fields fall back to this package's schema defaults (all three values above except the empty
extension list), and a row `config` in the bundle patch would sit below them as the composition
`base` layer. One caveat worth knowing: a section the schema rejects leaves the namespace
unregistered for that whole boot — the tweaks then quietly run on their defaults, and dsh reports
it only through its logger — so fix the document and restart.

## Lazy ssh

`ssh x@host "command"` pays for a TCP handshake, a key exchange and an authentication every single
time. The `ssh_run` tool keeps OpenSSH's own multiplexing instead: the first call to a server becomes a
master held open on a control socket under `controlDir`, and every later call joins it. The plugin owns
only the lifetime — a connection is released once it has been idle for `idleTimeoutMs`, and a call
arriving during that window reuses it and refreshes the timeout.

```text
ssh_run(server: "deploy@build-01", command: "uptime")
→ ssh deploy@build-01: exit 0 (fresh connection, 214 ms)
  --- stdout ---
   12:04:11 up 41 days,  3:19,  0 users,  load average: 0.31, 0.24, 0.19
ssh_run(server: "deploy@build-01", command: "df -h /")
→ ssh deploy@build-01: exit 0 (reused connection, 41 ms)
```

Each call is a new remote shell, so a `cd` does not carry over: join steps with `&&` inside one call. A
non-zero remote status is part of the answer rather than an error, so stdout, stderr and the status are
read together. Nothing about credentials passes through the plugin — keys, agent and `~/.ssh/config` are
ssh's business — and `BatchMode` is on by default, which makes a host whose key is not already trusted
fail with ssh's own message instead of waiting on a prompt a tool call cannot answer; connect to a new
host once by hand to accept its key, or turn `batchMode` off for the row.

### Configuration

All eight keys are optional, and a value that cannot work fails the row while it mounts:

| Key | Default | What it decides |
| --- | --- | --- |
| `idleTimeoutMs` | `300000` | how long a connection may sit idle before it is released |
| `commandTimeoutMs` | `120000` | the deadline for one command, when the call sets no `timeoutMs` |
| `connectTimeoutSec` | `10` | ssh's `ConnectTimeout`: the handshake, not the command |
| `maxOutputBytes` | `1048576` | per-stream output cap; past it that stream is marked truncated |
| `batchMode` | `true` | pass `-o BatchMode=yes` |
| `sshBinary` | `ssh` | the executable to run |
| `sshOptions` | `[]` | extra ssh arguments, inserted verbatim before the destination |
| `controlDir` | `$TMPDIR/dsh-lazy-ssh-<uid>` | where the per-server control sockets live, created `0700` |

The control directory is one per **user**, not one per process: two dsh processes running as the same
user find each other's masters, and the second one joins the first one's connection instead of dialing
again. That sharing has a sharp edge, because releasing a connection asks the master to exit — which
ends every session on it. An idle release in one process can therefore cut a command still running in
another, so **run one dsh process per user and machine**, or give the second one its own `controlDir`.

### What a hard kill leaves behind

An orderly shutdown releases every connection: the plugin's disposer runs on unload, and a
`process.on("exit")` hook covers a shutdown that got no further than `process.exit`. `SIGKILL` runs
neither, and OpenSSH detaches the master from this process (`daemon()` — fork plus `setsid`), so the
terminal's `SIGINT` does not reach it either. What is left in that case:

- an abandoned **idle** master closes itself within `idleTimeoutMs` plus 30s, because every client this
  plugin runs sets `ControlPersist` to exactly that;
- a master with a **call in flight** is never idle, so `ControlPersist` never fires, and the orphaned
  client keeps the connection — and the remote command — alive until that command ends.

That window is documented rather than closed. Closing it needs a process that outlives dsh: a tiny `sh`
keeper holding the read end of a pipe whose write end dsh keeps, so any death closes it and the keeper
signals ssh. Buying it means owning the master ourselves instead of letting OpenSSH daemonize it —
starting it with `-M -N`, waiting for it to become ready, noticing its death, restarting it — and paying
one more `sh` per call. `node_src/lazy-ssh/src/platform/ssh.ts` records that design, the experiment that
verified it on Linux, and the cost, next to the boundary it would close.

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
pnpm test                            # per-package checks (lazy-ssh: the pool against a fake ssh; ui-tweaks: both halves)
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
