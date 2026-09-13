# git-flow: many sessions in one repository

This note records the **claim design as it was argued before the git-flow rewrite**. The plugin as
it ships is described in [Design decisions](./design.md) and in the
[README](./README.md#the-git-flow-workflow); where this note and `node_src/git-flow/src/**`
disagree, the code is right. The reasoning that survived the rewrite is kept here as the record of
it, and each section says whether it still describes the shipped design or is the record of an
argument the rewrite decided against. The implementation this note was written against is not in the
tree any more; to read it, take it from the repository's history.

## What the rewrite kept, and what it changed

The claim is still the design's centre: one durable record per family saying which working tree it
may write in, keyed by the root of the delegation chain, read on the write path. Four things around
it changed, and they are why this note cannot be read as a description of the code:

- **The claim is made where the branch is opened, not at the first write.** The note argued for
  claiming inside the guard, ahead of the write, and attaching the branch later. The rewrite put the
  claim in `core.gitStart`, reached by `/git-start` or by the model through the `git_start` tool: the
  branch name is the input, so naming and claiming happen together and the record never has to
  describe a family that has no branch. The guard only reads; a session with no claim is refused and
  told to load the `git-flow` skill and call `git_start`.
- **The lock shipped, and it is a second file.** `ClaimStore.open` creates `<claimFile>.lock` —
  creating it is taking the lock — and `dispose` deletes it, so a store's lifetime is the whole
  critical section and readers take the lock too. A peer's lock is refused rather than waited for, and
  a lock file older than ten seconds is a leftover the next process takes over. The descriptor-riding
  lock the rewrite first reached for cannot be built: Node exposes no `flock`/`fcntl` locking at all,
  and the section on claiming under concurrency below records what that leaves.
- **Liveness is the session registry, and there is no pid.** `resumableSessionIds` answers "can this
  session still come back" from the resident sessions that have no `parentSession` — the roots a
  human opened. A claim outside that set is a sweep candidate, and the sweep's second gate is age.
- **The record is TOML, and no field of it is nullable.** `.dsh.local/git-flow.toml` holds a version
  stamp and one `[claims.<root-session-id>]` table per family with `branch`, `worktreeName` and
  `createdAt`. The `tree` / `worktreePath` / `pid` / `repoKey` / `note` fields proposed below are the
  note's, not the file's.

## The hole (pre-rewrite)

This section describes the failure the claim design was written to fix, against the implementation
that was current at the time. The rewrite closed it by refusing what the old design tried to observe
— see the note at the end of the section.

The plugin learned that a session existed at the moment that session **opened a branch**, and never
before. The ledger was written only from `record()` in `flow.ts`, and `record()` was called only from
`startFlow`, which ran only for `/git-start` or for the guard's auto-start. The guard reached its
auto-start only when the integration branch was checked out; every other path left through
`decideToolCall`'s `if (!position.onIntegration) return next()` without writing anything.
`/git-complete`'s adoption path built a record for a branch that was checked out but unrecorded, and
then did not persist it.

So a session standing on a feature branch that it did not open through `startFlow` was invisible: a
branch the human checked out by hand, one left behind by an earlier session, or one the session
created with `git switch -c` through the Bash tool — which the guard does not cover. The ledger
answered "which sessions have declared a branch", and the plugin read it as "who is here".

What that cost was one step earlier than it first appears. The same peer list fed two different
decisions, and the first was not a check at all:

- `startFlow`'s `wantsOwnCheckout` — `wantsOwnCheckout = others.length > 0 || (isDelegate &&
  explicitName !== undefined)` — decided whether a starting session was **isolated**. With an
  invisible neighbour this was `false`, so the session opened its branch **in place** and recorded
  `worktreePath: null`. Two families now shared one tree and one branch, and the plugin arranged it.
- the claimant test in `decideToolCall` came second, and by then the shared state existed.

The observed failure had exactly this shape: one ledger record — its owner's, written when it started
in place because it saw no peers — one unrecorded session, and two sessions writing the same files on
the same branch.

**The rewrite closed this by refusing what the old design tried to observe.** A session with no claim
cannot write at all: the guard denies the call and names `git_start`. There is no auto-start and no
guard-opened branch, so the invisible neighbour has nowhere to come from. The cost is that every
session must call `git_start` (or `/git-start`) before its first edit — a deliberate trade, not an
oversight.

## Occupancy and assignment

The note's distinction is still the right way to read the design, with one correction: the code no
longer fuses the two, because claiming *is* assignment now.

- **Occupancy** — which family is in which working tree, and on which branch. This is the claim file,
  and for a resolved family it is also `core`'s process-local memo.
- **Assignment** — which tree a family *should* work in. `core.gitStart` decides it once, from the
  claim file: the main tree when no other resumable family holds it, a worktree of its own when one
  does.

The note's proposal was to produce occupancy as its own act, at the write, without opening a branch.
The rewrite took the opposite ordering: assignment and occupancy are produced together, at the start,
because the branch name is the one input the guard cannot supply.

## The claim

A **claim** is one family's declaration that it is working in one repository, and which tree it is
doing that in. The word was already in the plugin: the old guard called the peer that owned a
checkout its *claimant*. A claim is what makes someone a claimant, so the vocabulary still lines up:

| Piece | What it is, as shipped |
| --- | --- |
| **claim** | the durable record: one per family per repository, in `.dsh.local/git-flow.toml` (`ClaimStore`) |
| **the memo** | `core`'s process-local cache of a resolved family: absent, `null` (no claim), `complete: false`, `complete: true` |
| **`git_start` / `/git-start`** | the act that writes a claim: it chooses the tree, writes the record, then creates the branch and the tree |
| **the containment test** | the guard's question: is the declared path inside the tree this family's claim names |

## When a claim is made

**Fixed in the rewrite: at the start, in the doors, not at the write in the guard.** The argument for
putting it at the write was that a claim exists to precede a write, and the rewrite agrees with the
premise while disagreeing with the conclusion, because the guard is the one place it cannot happen:

- **The guard cannot name a branch.** It answers `allow`, `deny` or `ask` and nothing else, and the
  arguments it sees are frozen, so it cannot open one either. Its refusal text is the only channel it
  has; opening the branch is a separate call the model makes, with the human reachable.
- **A name is a judgement, and the guard is not where a model is consulted.** The old guard made it
  anyway, through naming tiers that ended at a model call or at the human. The rewrite removed the
  tiers and made the name required input, so the claim and the branch decision still happen together
  — now in `git_start` and `/git-start` — and no step has to guess.

The two properties the note claimed for the write-time timing still hold, and are worth keeping:

- **Read-only work stays free.** `read`, `grep` and `glob` never reach the guard, so a session can
  explore the repository and agree on an approach before it commits to a branch name or a working
  tree. That is the moment a deliberate name can be chosen instead of derived, and it is what makes
  "discuss the name with the user" an available move rather than a fallback.
- **The claim and the branch decision happen together.** Both are consequences of "this session is
  about to change files here", and both need the same inputs — which tree am I in, who else can come
  back, what is this session's intent.

### And nothing belongs before thinking (rejected, and now gone entirely)

An earlier draft of this section argued for an **observation** at `agent/pre-step`: a read-only
refresh, writing nothing, so the prompt could name the session's branch and worktree before the first
request. It was implemented at the first read-only tool call instead, and then removed; the rewrite
deleted the prompt contribution it existed for, so the plugin now contributes no prompt section at
all. The reasons, in the order they turned out to matter:

- **The enforcement never needed it.** Whether a write is allowed is decided by the guard, by running
  git. A model told the wrong branch writes exactly as it would have otherwise.
- **Its useful half already arrives at the right moment.** A session isolated into a worktree learns
  the path from the guard's refusal, which names both the worktree and the exact file to write
  instead of the one it aimed at. Just in time, and never stale.
- **A cached branch can lie.** It changes when a human switches branches by hand, so the injected
  line could contradict reality in the transcript. A model that wants to know can run
  `git branch --show-current` and be right.

So the guard is the only thing that tells the model anything about position — by refusing a write and
saying where to make it instead. The workflow itself is a bundled skill (`git-flow`), which the model
loads when it needs the rules.

### Order inside the guard

As shipped, the guard is one listener on `tools/pre-execute` (`GIT_FLOW_INTERCEPTOR`), and its order
is a series of cheap filters before the repository is asked anything:

1. filter to the file-mutating tools (`write`, `edit`, `str_replace_editor`); anything else passes;
2. a call declaring no target passes, and so does `str_replace_editor command: "view"`;
3. a call that carries no agent passes — no session asked for it, so the plugin has no opinion;
4. the declared path is resolved against the session's cwd; a path **outside the repository** passes;
5. `ensureWorkspace` is asked where this family may write — a read of the claim file and, for a family
   whose claim is incomplete, the step that creates the branch or the worktree it names. It never
   writes a claim;
6. no claim means `deny`, naming the `git-flow` skill and `git_start`;
7. a path outside the claimed tree means `deny`, naming the exact path to use instead.

The note's step list — `ensureClaim()`, a second position read, the claimant test, the
integration-branch test and an auto-start — is the pre-rewrite guard and no longer exists. What
survives is the boundary the rewrite kept:

**The guarantee is bounded by the seam.** It holds for the file tools. `bash` is deliberately not
guarded, so a session can still mutate the repository through the shell without a claim, and
"read-only" is a property of the tools, not of the session. That is the same boundary the README
documents; it is named here because this design leans on it.

## The claim record

As shipped, in `.dsh.local/git-flow.toml`:

```toml
# Machine-local state for the dsh git-flow plugin. It records which session works in
# which working tree, and its paths are absolute paths on this machine. It is not
# repository content: do not commit it.

version = "0.1.0"

[claims.session-ea4ebc37-0e8e-4dbd-9a70-f1f442c58c0c]
branch = "feat/git-flow-rewrite"
worktreeName = "git_flow_rewrite"
createdAt = "2026-09-13T00:34:56.840Z"
```

Four things about the shape are decisions rather than accidents:

- **The session id is the table key and is not repeated in the row.** A second copy of an identity is
  a second source of truth, and the two can disagree.
- **`version` is written and never read.** It is there so a later format change has a field to branch
  on rather than a shape to guess at.
- **A row missing `branch`, `worktreeName` or `createdAt`, or carrying one that is not a string, is a
  hard read error rather than a dropped row.** A dropped claim reads as "no claim", and the next
  family would take a tree that is still spoken for.
- **`worktreeName` carries the assignment, and `[MAIN]` is its sentinel.** A family that holds the
  repository's own checkout records `[MAIN]`; every other value is one directory under
  `.dsh.local/worktrees/`, derived from the branch by stripping `feat/` and rewriting `-` as `_`
  (`feat/foo-bar` becomes `foo_bar`). The brackets are what make the sentinel unoccupiable: a real
  worktree's directory name is a branch subject, which is letters, digits and dashes only.

The note's proposal is not this file. It had `repoKey`, `tree`, `worktreePath`, `integration`, `pid`
and a `note` field, and a nullable `branch`, because claiming happened before a branch existed. The
rewrite needs none of them: a claim is written by `gitStart`, which has the branch name in hand and
creates the branch right after, and the repository is the file's own location. What the note argued
for and the code keeps is the reason the record exists at all: a session's working directory is
immutable, so after isolation its cwd is still the main tree, and only the record says where it is
supposed to write. That fact is *not* derivable from the session's cwd, and every door reads the
record instead.

## Claiming under concurrency

**The lock shipped, as a second file.** `ClaimStore.open` creates `<claimFile>.lock` and
`ClaimStore.dispose` deletes it, so creating the file is taking the lock and deleting it is releasing
it. A store holds it for its whole lifetime, which makes the read on the way in, every `append` and
`remove`, and the read a `query` or a `find` makes one critical section; readers take the lock too,
because the decisions above this module read and then write. A peer's lock is **refused rather than
waited for** — `open` throws, and whoever is above it runs the operation again — and the lock file's
**mtime** is the whole expiry rule: younger than ten seconds is held, older is a leftover, and the next
process takes a leftover over by writing its own owner line over it. Ten seconds is hardcoded for now,
like the plugin's other bounds; it moves into configuration with them.

That bound is sound only because a critical section is a few filesystem operations on a small file:
microseconds, not seconds. The invariant that keeps it sound is that **no store is held across a git
call** — the sweep takes its snapshot under one short lock, releases it, and only then removes trees.
Renewing the mtime while the lock is held was considered and rejected: a heartbeat has to run on the
event loop, a long synchronous turn delays it, and the lock then looks expired while it is still held.

**The gap this leaves** is recorded in `platform/claim.ts` rather than papered over here: two processes
can find the same expired lock and take it over in the same instant, and both then believe they hold
it. Closing it needs a primitive the filesystem does not offer — `unlink` removes whatever is at the
path now, not the file that was judged — so the alternatives are an election over one file per
contender, or never taking a lock over at all, and both cost more than the window.

The two terms this note wrote its deferred lock in are therefore **both reversed**, and the reason is
what Node does not provide:

- **There is a separate lock file after all.** The descriptor cannot carry the lock: `fs.constants`
  holds no `LOCK_*` flag and a `FileHandle` has no lock method, so there is no advisory lock to ride
  the descriptor the store writes through. Node's answer is that it will not provide one —
  [nodejs/node#49256](https://github.com/nodejs/node/issues/49256) was closed as not-planned on
  libuv's ruling that cross-platform file locking is broken differently on every platform — and this
  package takes no native dependency. A file whose existence *is* the lock is what is left.
- **Nothing waits, so there is no wait to bound.** The bounded wait existed to keep a busy-wait off
  the event loop; a refusal has no wait at all. What it costs is a retry one layer up, which the tool
  and the command already have a channel for.

The mechanism this note specified — a lock file beside the ledger, opened `O_EXCL`, broken once it is
old — is close to what shipped, and its measurement of `open(path, "wx")` (200 concurrent calls in one
process produce exactly one winner) is precisely the primitive the shipped lock is built on. What did
not survive is the pid: the owner line is written for whoever reads the file and nothing in the plugin
parses it, so the mtime is the only clock. A pid rule would have to survive pid reuse, and a pid
*veto* — never taking a lock whose owner is still alive — was considered and left out.

The alternative the note considered and rejected — **one claim file per family** — is still rejected
for the same reason: it removes the shared read-modify-write but not the decision, since two families
can still read "the main tree is free" at the same instant, and "choose over the whole set" is what a
lock is for.

## Liveness from the registry, ownership from the claim file

The two sources answer two different questions, and neither is about where a session happens to sit:

- the **claim file** records *claims* — which family may write in which tree. It is the authority for
  that, and nothing else is;
- the **registry** (`sessions.get(id)`, `sessions.list()`) answers *liveness* — whether the session a
  claim names can still come back. `resumableSessionIds` narrows it to the resident sessions with no
  `parentSession`, which is to say the roots a human opened; a subagent's family is the top-level
  session's family.

**A tree is free when no resumable claim names it.** That is the shipped rule, and it is narrower
than the note's "no claim owns it": a claim whose session can no longer come back is a leftover the
sweep will collect, and exiling the next session to a worktree because of it would keep the main tree
empty forever.

Residence is still not part of the rule, and the note's argument for that survives intact. A
session's working directory is immutable, so a session isolated into its own worktree still has the
**main tree** as its cwd for the rest of its life — it is only *told* to write absolute paths inside
the worktree. A rule that asked "is any other live session's cwd inside this tree" would therefore
mark the main tree permanently occupied by a session that will never write in it again, and each
isolated session would add one more such phantom, leaving the main tree idle while every session sat
in a worktree of its own. Liveness is needed; residence is not, and using it would have been a leak
that grows with the number of sessions.

The cost of the narrow rule is one extra worktree, and it is still worth stating as an accepted
consequence rather than discovered later: **the race for the main tree is won by the first family to
start, not the first session.** A session that reads for an hour before calling `git_start` may find
the tree claimed by a family that started sooner, and will be given its own tree. Nothing can be lost
in that move, because a session that had not started had nothing there.

Peer identity is still folded through the delegation root before it counts (`familyRoot` in
`boundary/shared.ts`), or a family's own subagent would look like a second family and be given a
branch and a tree of its own.

What is gone is the rest of the note's liveness rule. There is no pid, so there is no fallback for a
claim from another process, and no "neither is a veto on the other": the claim file is the only
channel that reaches across processes, and it is read as a record of ownership. Whether a session can
come back is answered in this process, and a claim from another process is simply not in
`resumableSessionIds` — the sweep's age gate is what keeps that from being too eager.

`agent/status` (`idle ⇄ running`) is available and deliberately *not* used to decide whether a peer
is in the way. In the Web GUI "idle" means the human may type at any moment, so treating idle as
absent would reintroduce the collision; the session records this plugin reads carry no status field,
and `agent/status` appears nowhere in the plugin.

## The memo

The note's "latch" has become `core`'s `sessionWorkspaceMemo`, and the note's description still fits
it in spirit: **a cache with no authority**. It is process-local by design, keyed by the family root,
and it answers one question — "where does this family write?" — never "is the recorded state still
true".

- **Four states, each meaning something different.** Absent: not resolved yet. `null`: asked, and
  this family holds no claim. `complete: false`: the claim named a branch and a tree, and nothing is
  known yet about whether they exist. `complete: true`: both are in place, so the resolution
  short-circuits with no git call and no claim-file read at all — the state a write on the hot path
  needs.
- **Loss is a miss.** A process restart, a cleared map, or a family that never claimed all take the
  same path: read the claim file and resolve. Nothing may be correct only because the map is warm.
- **Invalidation is explicit** at `gitStart` (which adds a claim, and drops the `null` a guard may
  have memoized moments earlier), and at `gitComplete` and `gitClean`, the two operations that take a
  workspace away.
- **It assumes `core` is the only thing that changes a family's tree.** That is the trade the note's
  latch deliberately did not make — the latch suppressed writes and still asked git on every call,
  while the memo's `complete: true` skips git entirely. A committed check names that boundary
  honestly: "characterized: a family torn down outside git-flow keeps its memoized answer and is not
  recreated" (`test/verify-core.mjs`).

## The guard

The note rewrote the guard's job, and the rewrite rewrote it again. As shipped, the guard has one
job, and it is still the plugin's only *enforcement* point:

- **containment** — the declared path must be inside the tree the family's claim names. The guard
  reads the claim through `ensureWorkspace`, and refuses when there is none, naming the `git-flow`
  skill and the `git_start` call.
- **No claiming, no auto-start, no integration-branch test.** The guard decides nothing about naming;
  it hands that decision to the model and the human.

Assignment stays lazy on purpose, and the note's reason still holds: a session that asks a question
and never writes never calls `git_start`, so it gets no worktree, no branch and no claim — the eager
version would pay a full checkout for every session that merely starts.

## What the model is told (rejected: it is told nothing about position)

This section argued that the plugin's root-scoped prompt context already covered subagents, because
its text provider resolved identity through the delegation root, and that only the guarantee of
non-empty text was missing. The section is kept as the record of an argument that did not survive
contact with the question "what does the model do differently for knowing?" — nothing, except in the
one case the guard already handles better by refusing a write and naming the path. The plugin now
contributes **no prompt section at all**; the workflow is the bundled `git-flow` skill, loaded when
the model needs it.

Two things stay as they are, deliberately:

- **the skill is advisory; the guard is the enforcement.** Text that says "write in your worktree"
  does not stop a write; the deny in the guard does, and it must keep naming the absolute path.
- **no model call is added to the claim path.** `core.gitStart` is fixed logic: no naming, no
  judgement, no latency the write has to wait on. The naming conversation happens in the open — in
  the read-only window, before the claim — and the door that records its outcome is `/git-start
  <name>` or the `git_start` tool.

## Commands

- **`/git-start [<feature-name>]`** — opens the branch and claims the tree; it is again the act that
  creates the family's existence, as it was before this note's design. Bare, it names nothing: it
  injects one notice telling the model to load the `git-flow` skill and call `git_start`.
- **`/git-complete [<merge-message>]`** — merges with `--no-ff` when the branch is ahead of `master`,
  releases the tree, deletes the branch and drops the claim. It declares an `input` hint now, unlike
  the previous implementation, because the merge message is the model's to compose. A branch that is
  not a descendant of `master` is reported `not-descendant` with the `git rebase --onto` command to
  run, and the caller replays it by hand: `core` never rebases.
- **`/git-cleanup`** — the counterpart to a session that was closed without finishing. It sweeps a
  claim only when its session cannot be resumed **and** the claim is older than a day, then releases
  the tree, deletes the branch with `-D` whether or not it is merged, and drops the claim last. That
  is the opposite of what this note first specified: the branch is where the work is, and the sweep
  deletes it anyway, so the two gates rather than a report are what make the deletion acceptable.
- **There is no exit hook.** `agent/disposed` is an emit, and a thread killed outright never reaches
  it. The rewrite added no hook and no prune-on-read: the sweep is only what `/git-cleanup` runs, and
  the 24-hour gate is what keeps a killed session's claim from being taken too early.

## Decisions taken

**1. The `.gitignore` check: dropped.** The rule is a one-time addition per repository and the model
is trusted not to commit a directory whose own first line says what it is — so the plugin neither
verifies nor writes `.gitignore`, and `ignore.ts`, the `FileAccess` seam that existed for that one
write, and the ten checks pinning its behaviour are gone. What was added at the time — excluding
`.dsh.local` from the plugin's own staging by pathspec — is gone too, because the rewrite runs no
staging command at all. The residual risk is unchanged and is a human's careless `git add --all`,
which is why the claim file opens with what it is.

**2. What happens to a claim whose process died without a hook.** `/git-cleanup` sweeps it once its
session is not resumable and the claim is older than 24 hours. It releases the tree — removing a
worktree with `--force`, or putting the main tree back on `master` when it still stands on the dead
branch — deletes the branch (`-D`, unmerged included), and drops the claim last, so a step that fails
leaves the record for the next sweep. A dead claim is not kept to preserve information, and its
branch is not reported before it is deleted: the sweep is one policy, and the two gates are what
stand in for the report.

**3. Whether the guard should stop re-reading the ledger on every call.** It effectively does, and
through the memo rather than a latch. The guard still calls `ensureWorkspace` on every file-mutating
call, but a family already marked `complete` is answered with no claim-file read and no git call. The
claim file is the authority again the moment the memo misses — a restart, a new family, or any
operation that changed the tree.

**4. Whether the model should be told where it stands.** No. This is the decision this note first got
wrong; the rewrite settled it in the same direction and went further, removing the static prompt
section as well as the context.

## Test plan

The checks the design now rests on are committed: six files under `node_src/git-flow/test/`, run by
`pnpm test` against a scratch repository with Node built-ins only — no harness, no profile, no
network. What this note planned is not quite what shipped, so here is what each file actually covers:

- `verify-exec.mjs` (8 checks) — the process seam: argv is never shell-interpreted, `GitClient`
  forces argv[0], cwd and the git environment, `text`/`run`/`ok`/`GitError` behave as their callers
  assume, and a caller's signal reaches the runner.
- `verify-claim.mjs` (17 checks) — the claim file's format (header, version), the table key as the
  identity, replacement and removal, both read paths, that a malformed document throws rather than
  reading as no claim, and the lock: that a store holds a lock file while it is open, that a second
  store is refused by name, that a young lock is respected, that an old one is taken over, that an open
  which fails on the document gives the lock back, and — with a real second process — that a lock held
  elsewhere refuses this one and dies with the process that held it.
- `verify-core.mjs` (30 checks) — the decisions: both workspace shapes, the memo's four states and
  its retry path, `gitComplete`'s steps including `not-descendant`, the temporary merge worktree, and
  the sweep's two gates. A check that pins a behaviour the module calls out of contract says
  `characterized` in its name.
- `verify-guard.mjs` (10 checks) — the five rules, and that no input produces `ask`.
- `verify-doors.mjs` (13 checks) — the descriptors both doors declare, the one injected notice, and
  that a tool injects nothing.
- `verify-skill.mjs` (5 checks) — the two bundled skills, their discovery metadata, and that each
  body is read from `assets/`.

The reproduction this note wanted first — two sessions in one repository, neither with a claim — is
still in the set in its rewritten form: the guard's "a write into the repository with no claim is
refused, naming the skill and `git_start`", and the core's "a family that arrives while another
resumable family holds the main tree gets a worktree cut from master".

## Non-goals

- No model call in the claim path: claiming is fixed logic in `core`, and naming happens before it,
  in the open.
- No attempt to make two sessions share one working tree safely. The answer stays isolation, because
  a shared checkout is unsafe under any amount of bookkeeping.
