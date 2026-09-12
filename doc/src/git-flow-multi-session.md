# git-flow: many sessions in one repository

**Status: proposed.** This note specifies a change to `node_src/git-flow` that is not implemented yet.
It refers to today's behaviour only as the thing being replaced; the plugin as it ships is described in
[Design decisions](./design.md).

## The hole

The plugin learns that a session exists at the moment that session **opens a branch**, and never before.
`rememberSession` has exactly one call site — `flow.ts:258`, inside `record()` — and `record()` is called
only from `startFlow` (`flow.ts:388`, `:478`, `:511`), which runs only for `/git-start` or for the guard's
auto-start. The guard reaches its auto-start only when the integration branch is checked out; every other
path leaves through `guard.ts:182` (`if (!snapshot.onIntegration) return next()`) without writing anything.
`/git-complete`'s adoption path (`resolveRecord`, `flow.ts:552`) builds a record for a branch that is
checked out but unrecorded, and then does not persist it.

So a session standing on a feature branch that it did not open through `startFlow` is invisible: a branch
the human checked out by hand, one left behind by an earlier session, or one the session created with
`git switch -c` through the Bash tool — which the guard does not cover unless `guardBash` is enabled. The
ledger answers "which sessions have declared a branch", and the plugin reads it as "who is here".

What that costs is one step earlier than it first appears. The same peer list feeds two different
decisions, and the first is not a check at all:

- `flow.ts:466` — `wantsOwnCheckout = others.length > 0 || (isDelegate && explicitName !== undefined)`
  decides whether a starting session is **isolated**. With an invisible neighbour this is `false`, so the
  session opens its branch **in place** (`flow.ts:473-491`) and records `worktreePath: null`. Two families
  now share one tree and one branch, and the plugin arranged it.
- `guard.ts:164-180` — the claimant test. That is the second chance, and by then the shared state exists.

The observed failure had exactly this shape: one ledger record (its owner's, written when it started in
place because it saw no peers), one unrecorded session, two sessions writing the same files on the same
branch.

## Two questions the current code fuses

- **Occupancy** — which family is in which working tree, and on which branch. Cheap to answer, needed by
  every decision, and today produced only as a side effect of opening a branch.
- **Assignment** — which tree a family *should* work in, and therefore whether a worktree must be created
  and a branch attached to it. Expensive: a branch, a tree, a name, and cleanup by `/git-complete`.

The change is to produce occupancy as its own act, at a defined moment, and leave assignment where it is —
at the first write, where the naming decision already lives.

## The claim

A **claim** is one family's declaration that it is working in one repository, and which tree it is doing
that in. The word is not new to this plugin: `guard.ts` already calls the peer that owns a checkout its
*claimant*. A claim is what makes someone a claimant, so the vocabulary lines up:

| Piece | What it is |
| --- | --- |
| **claim** | the durable record: one per family per repository, in `.dsh.local/git-flow.json` |
| **claim latch** | the in-memory skip — the flag that says a family has already claimed, so the work is not redone on every step |
| **`ensureClaim()`** | the action that reads the latch, and on a miss re-reads the ledger and claims if needed |
| **claimant test** | the guard's existing question: does another live claim own the tree I am about to write into |

## When a claim is made

`agent/pre-step`. It is a waterfall, it is awaited, it runs before every step of every turn, it carries the
turn's `signal`, and its decision type (`{kind: 'reject'} | {kind: 'enter', messages, startsRequestSeries?}`)
means it can also refuse a step. Three properties decide the choice:

- **It is before thinking.** Anything it does is complete before the model can call a tool, so no write can
  race the claim.
- **It is awaited, unlike `agent/session-start`.** That event is declared `@mode emit` and documented as "a
  notification, not a veto"; asynchronous work there is not ordered before the first request.
- **It is not agent-scoped.** A listener registered on the plugin's own context receives every agent, so one
  registration covers subagents, and `sessionRoot` folds them onto their parent (`session.ts:147`). This is
  the same property the guard already relies on.

Ordering matters for the prompt as well: pre-step runs before `agent/request`, and the system prompt is
assembled for the step being entered, so a snapshot refreshed in the handler is visible to *that* step's
prompt. Today the prompt can be one step stale; under this design the first step is never stale.

The cost per step is one map lookup. The expensive part runs once per family per repository, latched.

## The claim record

```jsonc
{
  "version": 2,
  "note": "Machine-local state for the git-flow plugin. Not repository content: do not commit it.",
  "claims": {
    "<root session id>": {
      "repoKey": "<absolute common git dir>",
      "tree": "main",              // "main" | "own" — the assignment, not the current position
      "worktreePath": null,        // set once an "own" tree exists
      "branch": null,              // the family's feature branch, null until one is attached
      "integration": "master",
      "pid": 19728,
      "sessionId": "<root session id>",
      "claimedAt": "2026-01-01T00:00:00.000Z"
    }
  }
}
```

Three changes from today's `SessionRecord` (`repo.ts:55-74`):

- **`branch` becomes nullable.** A claim is written before any branch exists — the honest state for a family
  that has claimed a tree and is still standing on the integration branch. It also settles a case the old
  shape forced into a lie: `SessionRecord.branch: string` was required, so the adoption path had to invent a
  branch to describe a session that had none.
- **`tree` is the primary axis, `branch` is secondary.** Worktree assignment is the durable fact; which
  branch that worktree has checked out may change. This is what makes the claimant test a *tree*
  comparison rather than a branch comparison — a strictly better test, since the recorded branch of a
  session that switched branches by hand is stale by construction, while "which tree does this family own"
  does not go stale that way.
- **`note` in the file.** JSON has no comments, so the explanation is a field. It is advisory only: the
  plugin does not depend on anyone reading it, and the guard's enforcement does not depend on a model
  choosing to respect it. See [Open decisions](#open-decisions).

`state.refresh` keeps reading `worktreePath` from this record (`state.ts:134`), and it must: a session's
working directory is immutable, so after isolation its cwd is still the main tree, and only the record says
where it is supposed to write. That fact is *not* derivable from the session's cwd.

## Claiming under concurrency

Claiming is a read-modify-write of one JSON file shared by every process working in the repository, so it
happens inside a lock:

1. open `<repo>/.dsh.local/git-flow.lock` with `O_EXCL`, writing the pid and a timestamp;
2. on `EEXIST`, read the holder; if its pid is gone or its timestamp is older than a generous timeout, break
   the lock and retry once, otherwise wait briefly and retry;
3. inside the lock: read the ledger, decide, write it (`writeLedger`'s tmp+rename is already atomic per
   write), release.

Whoever holds the lock first and finds the main tree unclaimed takes it; everyone else is assigned an own
tree. That rule needs the ledger inside the lock, because "is the main tree free" is exactly what the lock
protects. The lock does **not** decide whether anyone is physically standing in the main tree — that is git's
answer (`worktree list --porcelain`), and it is what the guard checks before allowing a write.

The lock also removes the lost-update race that this design would otherwise make ordinary: with claiming on
every session's first step, two processes starting at once would each read an empty ledger and each write
their own record, and one claim would disappear. (Reads stay lock-free: a reader that catches a
half-visible state can only be wrong for one step, and the next step re-reads.)

## Peer liveness from the registry, peers across processes from the ledger

`ctx.sessions` is the harness's own in-memory store: `get(id)` and `list()` ("all live sessions, in creation
order"), each session carrying `header.cwd`, `parentSession`, `origin` and `delegationDepth`. That answers
occupancy for **this process** exactly and without a single write — including sessions that have not claimed
anything yet, which is precisely the case a write-based mechanism cannot cover.

Peer identity is folded through `sessionRoot` before it counts, or a family's own subagents register as
strangers and flip `wantsOwnCheckout` — the bug `03fd42c` fixed, reintroduced through a new data source.

The ledger stays, for the case the registry cannot see: a second dsh process working in the same repository.
The division is clean and worth stating as a rule:

- **same process** — the registry is authoritative, and needs no claim at all;
- **other processes** — the ledger is the only channel, and it requires that session to have claimed;
- **neither is a veto on the other**: a peer is a peer if either source reports it.

`agent/status` (`idle ⇄ running`) is available and deliberately *not* used to decide whether a peer is in
the way. In the Web GUI "idle" means the human may type at any moment, so treating idle as absent would
reintroduce the collision; it is useful in reports, not in decisions.

## The latch

The latch is a cache with no authority. It answers one question — "has this family already claimed in this
repository in this process?" — and never answers "is the recorded state still true".

- **Key:** `sessionRoot` (so a subagent hits its parent's entry) plus `repoKey` (one process can host
  sessions in several repositories).
- **Loss is a miss.** A process restart, a cleared map, or a family that never claimed all take the same
  path: read the ledger and claim if needed. Nothing may be correct only because the latch is warm.
- **Invalidation is explicit** at `/git-start` (the claim's branch changed) and `/git-complete` (the claim is
  released), and the state is re-read, not assumed.
- **It suppresses writes, never checks.** The guard keeps asking git what is true on every file-mutating
  call; the latch only stops the claim path from rewriting the ledger on every step.

## The guard after this change

Two of its three jobs get simpler and one gets earlier:

- **containment** — unchanged in shape, but now fed by a claim that exists from the first step, so a session
  isolated mid-life is redirected for its whole life rather than from the write that created the worktree.
- **claimant test** — becomes "does another live claim own the tree I am about to write into", comparing
  trees instead of branches (`guard.ts:166-180` loses its `record.branch === snapshot.branch` conjunct, and
  gains correctness for a peer that switched branches by hand).
- **the integration-branch test** — the auto-start it triggers still happens where it does today: at the
  first write, when the session's intent is available and a name can be derived or asked for. Claiming does
  not open a branch, so nothing about naming moves.

Assignment stays lazy on purpose. A session that asks a question and never writes should not get a worktree,
a branch, or an entry in a "branches nobody completed" report — the eager version of this design pays a full
checkout for every session that merely starts, and the existing abandoned-branch reporting in
`startFlow` shows what those leftovers cost.

## What the model is told

The injection already exists and already covers subagents: `registerPrompt` registers a root-scoped section
and context, and the context's text provider resolves identity with `sessionRoot(agent, ctx.sessions)`
(`prompt.ts:126`), so a subagent renders its family's text. What is missing is only the guarantee that it is
*not empty* — `renderState(undefined)` returns `""`, and a snapshot exists only after some asynchronous path
refreshed it. Claiming at pre-step is what fills that gap for the first step.

Two things stay as they are, deliberately:

- **the prompt is advisory; the guard is the enforcement.** Text that says "write in your worktree" does not
  stop a write; the deny-and-redirect in the guard does, and it must keep naming the absolute path.
- **no model call is added to the claim path.** Claiming is fixed logic: no naming, no judgement, no
  latency the step has to wait on.

## Commands

- **`/git-start`** — unchanged in intent, one meaning narrower: it attaches a branch to the tree the family
  already claimed, instead of being the act that creates the family's existence.
- **`/git-complete`** — unchanged, plus releasing the claim (already `forgetSession`, `flow.ts:771`) and
  clearing the latch.
- **`/git-cleanup`** (new) — the counterpart to a session that was closed without finishing. It prunes claims
  whose owner is provably gone, removes orphan worktrees that are clean, and **reports** what it will not
  delete: worktrees with uncommitted changes, and branches with unmerged commits. It never deletes unmerged
  work — that rule already exists (`repo.ts:47-52`, the outstanding-branch report) and the command is its
  interactive form. Bare, with no `input` declaration, for the reason `/git-complete` is bare
  (`doc/src/design.md`): a command whose whole input is "now" should run on one pick.
- **an exit hook is best-effort, not the mechanism** — `agent/disposed` is an emit and a thread killed
  outright never reaches it. `/git-cleanup` and the existing prune-on-read are the backstop, and cleanup
  reports rather than silently forgets.

## Open decisions

**1. The `.gitignore` check — needs a ruling.** The current design verifies (and if needed writes) the
`.dsh.local` rule before any state is written, and refuses to create a worktree whose rule a later negation
would defeat (`ignore.ts`, called at `flow.ts:458` and `:608`). The proposal is to drop the check and rely on
(a) the rule being a one-time addition per repository and (b) the model understanding that `.dsh.local` is
not repository content. The conflict is concrete, and two of its three failure modes do not involve a model
at all:

- `/git-complete` runs `git add --all` **itself** when a branch has uncommitted work (`flow.ts:631`, default
  `commitUncommittedBeforeMerge: true`). It would commit the ledger — a file whose contents are absolute
  machine-local paths, which this repository forbids in committed files.
- A linked worktree inside the repository is staged as a **gitlink** (mode 160000) when the rule is absent.
  `test/verify-ignore.mjs` asserts this deliberately, so the premise is verified rather than assumed.
- A human running `git add -A` is unaffected by any model's judgement.

Options:

| Option | What it costs |
| --- | --- |
| **A. Trust the file contents** (as proposed) | Nothing at runtime; accepts the three failures above |
| **B. Move the claim out of the working tree** — back to `<git-common-dir>`, which needs no rule because git never stages it | Reverses the `.dsh.local` decision in [Design decisions](./design.md); the worktree rule is still needed, but only on the isolation path |
| **C. Verify once per repository, cached in the latch** | One check per process per repository — the same "one-time work" the proposal assumes, without trusting anyone |

**2. Where the claim is broken when a process dies without a hook.** Recommended: a claim is pruned only
when its owner is provably gone *and* nothing of its work remains to be reported; a claim whose worktree or
branch still exists is kept and reported, because the alternative is a silently forgotten branch — the one
thing the ledger must not do (`doc/src/design.md`).

**3. Whether the guard should stop re-reading the ledger per call.** With a warm latch, the file read per
file-mutating call is avoidable. Recommended: keep it. It is one small read, and it is what makes a change
made by another process (a cleanup, another session taking the main tree) visible without a restart.

## Test plan

The reproduction from the failure becomes the first committed check: two sessions in one scratch repository,
neither of which opened a branch through `startFlow`, must not both end up allowed to write in the main tree.
Beyond it:

- `verify-claim.mjs` — the latch (claim once, then skip; loss is a miss), keying by delegation root, the
  lock (two claimers racing for the main tree: exactly one gets it), and the nullable-branch record.
- `verify-guard.mjs` (extend) — the claimant test on trees, including the peer that switched branches by
  hand.
- `verify-flow.mjs` (extend) — `/git-cleanup`: an orphan worktree is removed, a dirty one and an unmerged
  branch are reported and left alone.

All checks stay in the committed-test shape the plugin already uses: Node built-ins only, a scratch
repository, no harness and no profile (`pnpm test`).

## Non-goals

- No model call in the claim path, and no new tool: claiming is fixed logic on an existing hook.
- No change to merge, rebase, or naming semantics.
- No attempt to make two sessions share one working tree safely. The answer stays isolation, because a shared
  checkout is unsafe under any amount of bookkeeping.
