# git-flow: many sessions in one repository

**Status: implemented, with two deviations recorded below.** This note specifies the claim design in
`node_src/git-flow`; the plugin as it ships is described in [Design decisions](./design.md), and the
sections here that describe *why* rather than *what* are the record of the reasoning.

Two things did not land as written:

- **The observation lives on `tools/pre-execute`, not `agent/pre-step`.** A read-only tool call now
  refreshes the snapshot and writes nothing, which is what keeps the prompt's state line filled while
  a session explores. `agent/pre-step` would observe before the *first request* rather than at the
  first tool call — strictly better — but it would make `@deepseek-ai/dsh-agent` a package dependency
  for one line of freshness. The trade is recorded in `guard.ts` where it is made.
- **`/git-cleanup` removes a clean orphan worktree even when its branch is unmerged.** This note first
  said to keep it, on the grounds that it is one step away from unmerged work. That was wrong:
  `git worktree remove` takes the checkout, not the branch, and the report names the branch either
  way. What must never be deleted is the work, and the work is the branch.

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

The change is to produce occupancy as its own act rather than as a side effect of opening a branch — and to
produce it at the **write**, where assignment already lives, rather than at the start of thought. That second
half is a correction to the first draft of this note, and it is argued in the next section rather than assumed.

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

At the **write**, in the guard the plugin already has (`tools/pre-execute`, `guard.ts`). The first draft of this
note put it at `agent/pre-step`, on the theory that earlier must be safer. Earlier is not the same as needed, and
the difference is the whole of the argument:

- **A claim exists to precede a write, not to precede a thought.** Nothing a read-only session does can collide
  with anyone, so a claim taken while reading buys nothing and costs something. It would make every session that
  merely starts declare itself — the side effect the current design is careful to avoid, since today nothing is
  written until a branch is opened.
- **It would invert a dependency.** Naming a branch and a worktree is a judgement, and this design wants that
  judgement made *with* the human, after the model has looked at the repository. A claim demanded before the model
  may think forces a name before the discussion that produces it: the naming tiers would run against an opening
  prompt that has not been explored yet, and the honest outcomes are a guess or a denial. There is no literal
  recursion here — the claim path calls no model at all, which stays a rule — but there is an ordering inversion,
  and the guard is where that dependency already runs the right way round: `startFlow` is called from the guard,
  the three naming tiers (mechanical → model → human) live there, and the human is reachable at that moment.

Two properties follow, and they are why this timing is better rather than merely cheaper:

- **Read-only work stays free.** `read`, `grep` and `glob` never reach the guard, so a session can explore the
  repository and agree on an approach before it commits to a branch name or a working tree. That is the moment a
  deliberate name can be chosen instead of derived, and it is what makes "discuss the name with the user" an
  available move rather than a fallback.
- **The claim and the branch decision happen together.** Both are consequences of "this session is about to change
  files here", and both need the same inputs — which tree am I in, who else is live, what is this session's
  intent. Split across two seams, those inputs would be resolved twice, at two moments, with no defined answer for
  what to do when they disagree.

### One thing does belong before thinking: the observation

Not the claim — the **observation** that lets the prompt say where the session is standing. `renderState` reads a
snapshot that exists only after `state.refresh` has run, and under this timing that happens on the write path; a
session that spends its first turn reading would be told nothing about its branch, which is exactly what it needs
in order to negotiate a name. So `agent/pre-step` keeps a read-only role: refresh the snapshot, write nothing.

It is a suitable seam for it: a waterfall, awaited, carrying the turn's `signal`, and not agent-scoped — a listener
on the plugin's own context receives every agent, and `sessionRoot` folds subagents onto their parent
(`session.ts:147`), so one registration observes every session. It also runs before `agent/request`, and the prompt
is assembled for the step being entered, so a snapshot refreshed there is visible to *that* step; today it can be a
step stale.

### Order inside the guard

1. filter to file tools, resolve cwd and identity, read the repo facts;
2. **`ensureClaim()`** — inside the lock: read the ledger, assign a tree, write the ledger;
3. refresh again, because the claim may have just changed the assignment (the guard already re-refreshes after
   `startFlow`, `guard.ts:220-222`, for the same reason);
4. containment, claimant test, integration-branch test — in the order they run today.

`ensureClaim` decides only the **tree**; `branch` and `worktreePath` are still filled in by `startFlow` or by the
redirect path, which is why the record can honestly hold nulls (see [The claim record](#the-claim-record)). When
it has already changed the tree, the write that triggered it points at the tree the session has just left — the
case the guard's redirect already handles (`guard.ts:229-237`), so the claim needs no new mechanism there; it is a
second producer of a case that is already covered.

**The guarantee is bounded by the seam.** It holds for the file tools. `bash` is deliberately not guarded by
default (`guardBash: false`), so a session can still mutate the repository through the shell without a claim, and
"read-only" is a property of the tools, not of the session. That is the same boundary the plugin already documents;
it is named here because this design leans on it.

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

1. open the lock file beside the ledger with `O_EXCL`, writing the pid and a timestamp;
2. on `EEXIST`, read the holder; if its pid is gone or its timestamp is older than a generous timeout, break
   the lock and retry once, otherwise wait briefly and retry;
3. inside the lock: read the ledger, decide, write it (`writeLedger`'s tmp+rename is already atomic per
   write), release.

Whoever holds the lock first and finds the main tree **unclaimed** takes it; everyone else is assigned an own
tree. That rule needs the ledger inside the lock, because "is the main tree free" is exactly what the lock
protects. The lock decides ownership, not occupancy: whether anyone is physically standing in a tree is git's
answer (`worktree list --porcelain`), and a session's presence there grants it nothing.

The lock also removes the lost-update race that this design would otherwise make ordinary: with claiming on
the first write of every session that writes, two processes whose first writes land together would each read
an empty ledger and each write their own record, and one claim would disappear. (Reads stay lock-free: a
reader that catches a half-visible state can only be wrong for one step, and the next step re-reads.)

### Why one lock covers both cases

`O_EXCL` is enforced by the kernel, not by the process, so it excludes **within** one process exactly as well
as between two — which matters, because two sessions of one dsh process are the ordinary case, and a lock that
only worked across processes would leave the common one unguarded. Measured rather than assumed: 200
concurrent `open(path, "wx")` calls in one process produce exactly one winner, and two processes racing 100
times each both make progress.

Working from a filesystem does add four obligations, and each one has a failure that is silent if it is
skipped:

- **The critical section must not await git.** Two sessions in one process share an event loop, so a holder
  waiting on a subprocess leaves the other session's write spinning behind it. Everything the decision needs
  from git — the main tree, the worktrees, the current branch, the integration branch — is computed *before*
  the lock is taken; inside it, only the ledger is read and written.
- **Waiting must be asynchronous.** A busy-wait would block the event loop, which in the same-process case
  blocks the very holder whose release is being waited for: a deadlock, not a delay. Retry on a timer, with
  jitter — the fairness the measured 45/3 split lacks.
- **Release must be compare-and-delete on a token** (the pid plus a per-acquisition id), never a bare unlink.
  When a stale lock is broken, the old holder is still inside its critical section with no idea it lost the
  lock; if it then releases blindly it deletes the *new* holder's file and a third claimant walks in. This is
  the one failure the measurement caught directly.
- **A live holder is never broken on a timeout alone.** With the critical section bounded to filesystem work,
  a pid that is alive means the holder is progressing, so only a dead pid — or a timestamp far beyond any
  plausible section — justifies breaking in.

Two limits are worth naming rather than discovering. On a network mount, `O_EXCL` is emulated client-side by
older NFS and the pid test describes another machine's process space, so exclusion there is best-effort and
only the timeout recovers a dead holder; two machines sharing one checkout are out of scope for the same
reason the ledger holds absolute machine-local paths. And this is POSIX behaviour as verified on Linux —
`wx` maps to a create-new open on Windows too, but the pid liveness rule does not port unchanged.

The alternative that was considered and rejected: **one ledger file per family**, which removes the shared
read-modify-write entirely. It does not remove the decision — two families can still read "the main tree is
free" at the same instant — so it needs either a lock anyway or a second round that resolves the tie, and the
claim decision is precisely "choose over the whole set", which is what a lock is for.

## Liveness from the registry, claims across processes from the ledger

The two sources answer two different questions, and neither is about where a session happens to sit:

- the **ledger** records *claims* — which family may write in which tree. It is the authority for that, and
  nothing else is;
- the **registry** (`ctx.sessions`: `get(id)`, `list()` — "all live sessions, in creation order", each with
  `header.cwd`, `parentSession`, `origin`, `delegationDepth`) answers *liveness* — whether the session a claim
  names is still there, in this process, with no write involved.

**A tree is free when no claim owns it.** That is the whole rule, and the lock is what makes it sufficient: a
claim is written by the first writer under the lock, and every later writer reads it and is assigned an own
tree. Physical presence confers no write right — a session that has claimed nothing is denied a write into
another claim's tree by the claimant test, so being *in* a tree without a claim cannot cause the collision that
matters.

Residence was in an earlier draft of this rule, as a second condition, and it was not merely redundant but
wrong. A session's working directory is immutable, so a session that has been isolated into its own worktree
still has the **main tree** as its cwd for the rest of its life — it is only *told* to write absolute paths
inside the worktree. A rule that asked "is any other live session's cwd inside this tree" would therefore mark
the main tree permanently occupied by a session that will never write in it again, and each isolated session
would add one more such phantom, leaving the main tree idle while every session sat in a worktree of its own.
Liveness is needed; residence is not, and using it would have been a leak that grows with the number of
sessions.

The cost of the narrow rule is one extra worktree, and it is worth stating as an accepted consequence rather
than discovered later: **the race for the main tree is won by the first writer, not the first session.** A
session that reads for an hour before writing may find the tree claimed by someone who wrote sooner, and will
be given its own tree. Nothing can be lost in that move, because a session that had not written had nothing
there to move.

Peer identity is folded through `sessionRoot` before it counts, or a family's own subagents register as
strangers and flip `wantsOwnCheckout` — the bug `03fd42c` fixed, reintroduced through a new data source.

The ledger is also what survives a restart: a claim is a file, so a resumed session finds its own claim and
takes it back, while the registry — being in memory — has forgotten everyone. That is the other half of why
the ledger is the authority and the registry is a liveness oracle over it. Stated as a rule:

- **same process** — the registry answers liveness, the ledger answers ownership;
- **other processes** — the ledger is the only channel, and pid is the fallback for liveness, which is exactly
  where it is known to be wrong (see [TODO](./todo.md));
- **neither is a veto on the other**: a claim counts if its owner is live by either source.

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
  call; the latch only stops the claim path from rewriting the ledger when nothing has changed.

## The guard after this change

Its three existing jobs stay, with one addition ahead of them:

- **`ensureClaim()` runs first**, because every later decision depends on knowing which tree this family owns.
  The guard becomes the single place where a session's existence is established — which is the point of the
  timing: it is the last moment before the invariant can be broken, and the first moment at which breaking it
  would matter.
- **containment** — unchanged in shape, now fed by a claim that exists before the first write, so a session
  isolated mid-life is redirected for the rest of its life rather than from the write that created the worktree.
- **claimant test** — becomes "does another live claim own the tree I am about to write into", comparing trees
  instead of branches (`guard.ts:166-180` loses its `record.branch === snapshot.branch` conjunct, and gains
  correctness for a peer that switched branches by hand). The tree comparison subsumes the branch one because
  git allows a branch in at most one working tree, so a family's branch can only be checked out in the tree it
  owns.
- **the integration-branch test** — unchanged: the auto-start it triggers still happens at the first write,
  when the session's intent is available and a name can be derived or asked for. Claiming does not open a
  branch, so nothing about naming moves.

Assignment stays lazy on purpose. A session that asks a question and never writes should not get a worktree,
a branch, or an entry in a "branches nobody completed" report — the eager version of this design pays a full
checkout for every session that merely starts, and the existing abandoned-branch reporting in
`startFlow` shows what those leftovers cost.

## What the model is told

The injection already exists and already covers subagents: `registerPrompt` registers a root-scoped section
and context, and the context's text provider resolves identity with `sessionRoot(agent, ctx.sessions)`
(`prompt.ts:126`), so a subagent renders its family's text. What is missing is only the guarantee that it is
*not empty* — `renderState(undefined)` returns `""`, and a snapshot exists only after some asynchronous path
refreshed it. The pre-step observation is what fills that gap, and it has to be the observation rather than the
claim: a session that reads first and negotiates a name needs to know where it is standing *before* it writes
anything.

Two things stay as they are, deliberately:

- **the prompt is advisory; the guard is the enforcement.** Text that says "write in your worktree" does not
  stop a write; the deny-and-redirect in the guard does, and it must keep naming the absolute path.
- **no model call is added to the claim path.** Claiming is fixed logic: no naming, no judgement, no latency
  the write has to wait on. The naming conversation happens in the open, between the model and the human, during
  the read-only window — and `/git-start <name>` is what records its outcome, with a `git_start` tool as the
  model-side counterpart if that gap is ever worth closing (it is the same open item as in
  [TODO](./todo.md)).

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
| **C. Verify once per repository, cached in the latch** (recommended) | One check per process per repository, on the write path only |

C is the recommendation, and the timing decided above is what makes it cheap enough to be the answer: the
check runs when a session first writes, which is the same moment the ledger is first written, and a session
that only reads never pays it. The proposal's premise — that the rule is one-time work per repository — is
exactly right; C implements that premise instead of assuming it, and it costs nothing that A does not also
cost, because in a repository that already has the rule the check only reads.

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
  lock (two claimers racing for the main tree: exactly one gets it), the free-tree rule (a session with no
  claim is given an own tree when it finally writes, and an isolated session does not hold the main tree by
  virtue of its unchanged cwd), and the nullable-branch record.
- `verify-guard.mjs` (extend) — the claimant test on trees, including the peer that switched branches by
  hand, and the read-only path: a `read`/`grep` call must write nothing at all.
- `verify-flow.mjs` (extend) — `/git-cleanup`: an orphan worktree is removed, a dirty one and an unmerged
  branch are reported and left alone.

All checks stay in the committed-test shape the plugin already uses: Node built-ins only, a scratch
repository, no harness and no profile (`pnpm test`).

## Non-goals

- No model call in the claim path, and no new tool: claiming is fixed logic on an existing hook.
- No change to merge, rebase, or naming semantics.
- No attempt to make two sessions share one working tree safely. The answer stays isolation, because a shared
  checkout is unsafe under any amount of bookkeeping.
