# The `subagent` tool can go missing

This page records an investigation into a defect observed in the deployment this repository is
developed against (dsh CLI `0.1.5-rc.1`, installed packages `0.1.5-rc.2`). It is a record of
findings at one point in time: **the cause is not established.** Every claim below says whether
the evidence establishes it or is merely consistent with it, and two arguments that were tried
and found unsound are recorded so the next attempt does not repeat them.

The experiment that produced most of the numbers lives in the local scratch area
`target/exp/` (`REPORT.md`, gitignored), not in the repository.

## The symptom

`@deepseek-ai/dsh-tool-subagent` can contribute **no tool at all** to a session, rather than a
tool with fewer parameters:

- `subagent` (the delegation tool) is absent from the session's tool table — the request header
  sent to the model carries no schema of that name.
- It is absent in sessions that were **created under the default `standard` preset and then
  switched to `cordis`**.
- Once absent, it never appears later in that agent's life. Agent re-creation restores it.

The fingerprint is that the sibling row is unaffected. In the same preset, in the same group,
with the same providers:

| row | config | tool |
|---|---|---|
| `tool-subagent` | `modelSelectionSettings: true` | missing in the affected sessions |
| `tool-subagent-fork` | no `modelSelectionSettings` | present in every session |

`spawn` and `fork` are both registered, both advertise `agentOptions` and `prepareContinuable`;
the composition inventory reports the `tool-subagent` row `enabled` with a live fiber state.
So the failure is not in the composition, the providers, or the credential plane.

### This is a different problem from "cannot choose a model"

Two independent switches are easy to conflate:

| switch | where | what it controls |
|---|---|---|
| `modelSelectionSettings: true` | the preset row | which **install path** the row takes (see below) — implicated in this defect |
| `subagent-model-selection.enabled` | `$DSH_HOME/settings.yaml` | whether the tool exposes `provider`/`model`/`reasoning_effort` and registers `list_subagent_models` |

The settings switch is off by default and is sampled when a session's agent is composed, so it
never applies to an existing session. With it off, a healthy `subagent` has exactly three
parameters — `description`, `prompt`, `run_in_background` — and that is what every healthy
session in the corpus shows. Turning it on does **not** bring back a missing tool.

## Why this row is the one that breaks

`modelSelectionSettings: true` moves the row off the ordinary path:

- **Ordinary path** (what `tool-subagent-fork` takes): `install()` runs once inside `apply()`,
  registering the tool on the composition's scope. Every agent that joins that composition sees
  it, whenever it joins.
- **Standing path** (what `tool-subagent` takes): the tool is installed **per agent**, driven by
  the `agent/created` event, by one `reconcileComposedAgents()` call at `apply()` time, and by
  a second one on every `tools/change`. Each candidate must pass
  `belongsToComposition(candidate)` — `scopeChainOf(scopeOf(agent.ctx)).includes(compositionScope)`
  — before `installScoped()` runs.

A preset switch is a **parent-scope re-link**, not an unmount and remount: `recompose()` moves the
agent's scope key to the new preset's standing mount and emits `tools/change`. The candidate
mechanism — **inference, not established** — is that this reconcile is a single unprotected loop
over `agents.list()`: the old preset's row removes the tool it installed
(`belongsToComposition` is now false), the new preset's row must re-install it, and if any
candidate before the new agent throws inside `installScoped()` (in `selectForSession()`, in the
`ctx.inject([...])` callback, or in `tools.register()`), the loop aborts, the new agent is never
reached, and every later `tools/change` aborts in the same place — which would explain the
"never self-heals" half of the symptom.

Nothing here has been observed directly. Dynamic plugins cannot read another agent's tool
visibility, so the branch that actually happens is indistinguishable from the outside.

## What the observations establish

### Sessions are not isolated per profile

`$DSH_HOME/sessions/<cwd-slug>/<session-id>/` is keyed by working directory, not by profile, and
the same session is resumed by whichever profile boots next. The session this page was written
from is the proof: its own request headers read `DIRTY -> CLEAN -> DIRTY`, at timestamps that
match each profile's `cordis.yml` mtime (the file dsh rewrites on every boot), and the profile's
`patchReload: live` user layer is not involved.

Two consequences:

- A session's tool table can change under it when another profile's process resumes it.
- Historical sessions cannot be attributed to a profile by path or by time. The only reliable
  attribution is the composition read from that session's **own** request headers.

### Observations cluster by boot, not by session

Grouping the target path ("created `standard`, then switched") by the boot that served it, no
boot shows both outcomes: a boot either keeps the tool for every session or loses it for every
session. That is consistent with the failure being a **per-process condition**, not a per-agent
race — but the boot boundaries are inferred from `resume` headers and composition flips, so this
is "consistent with the data", not a measurement.

### The numbers, and how little they support

| composition of the boot | target-path observations | tool lost |
|---|---|---|
| with the `@dsh-external/dotdsh` bundle | 8 | 4 |
| without it (`web-clean`) | 11 | 0 |

The tempting reading — "the plugins cause it" — is not supported:

- The unit of observation is the **boot**. The eleven clean observations sit in one or two boots,
  so they are not eleven independent trials, and a session-level significance test on clustered
  observations is pseudo-replication.
- At boot level the counts are 0/3 versus 2/4 (Fisher p ≈ 0.4): not significant, with nothing
  like the sample needed.
- "Without the bundle" and "that particular boot" are the same variable here, because a profile
  change *is* a boot. The two cannot be separated from this corpus.
- A dirty boot also kept the tool in a session whose switch→first-request window was 6.5 seconds —
  too short for a boot or an eviction to have rescued it. So the bundle is not a sufficient cause;
  at most it is one candidate factor in "which boots go bad".

### What holds regardless of the cause

- **Not deterministic.** The path succeeds often, in both compositions.
- **Lost is lost.** Within one agent instance the tool never returns, including after other tools
  register and emit `tools/change`.
- **Re-creation restores it.** Every recovery observed happens on the first request header whose
  reason is `resume`, i.e. the first request of a new agent instance for that session.

## Two arguments found unsound

Recorded because both look convincing and both are wrong.

1. **"If the survivors had been rescued by a re-creation, their first request would say
   `resume`."** Only true when a request had already been logged. The reason is
   `baseline === undefined ? "initial" : "resume"` against the *session log*, so an agent
   re-created **before the session's first request** still logs `initial`. This argument does not
   refute a rescue; the 6.5-second window does.
2. **"Those agents were alive together, so one process produced both outcomes."** A live agent
   proves that *its instance* was created in that process — not that the session's first request
   was served by it. Because sessions are not profile-isolated, that request may belong to an
   earlier boot. The four agents used to argue this turned out to be separated by at least two
   boots.

Also worth not repeating: overlapping single-arm confidence intervals are not a test of a
difference; and with observations clustered inside boots, a session-level exact test is not one
either.

## What to do meanwhile

- **Do not depend on the switch path.** Set the default preset so a session is composed from the
  wanted preset at creation:
  ```yaml
  # $DSH_HOME/settings.yaml — read when a session is created
  agent-presets:
    default: <preset id>
  ```
- **In an authored preset, avoid `modelSelectionSettings: true` on a delegation row.** Rows that
  omit it register once at composition and are visible to every agent of that preset. Give each
  row its own `toolName` and `agentOptions` — `subagent_fast`, `subagent_deep` and so on — and the
  tool name carries the routing choice, which is also the shape a fixed tier→model policy wants.
- **To recover a session that lost the tool:** restart dsh, or reopen the session. Re-creating the
  agent is what fixes it; reloading the page is not reliable, because the agent lives in the Host.

## What to do next

1. **One boot, both arms.** The profile's `cordis.patch.yml` hot-reloads, so the bundle's five
   rows can be toggled `disabled: true/false` inside a single process. Twenty or more trials per
   arm, counted **by boot**, is the only design that separates "the bundle" from "that boot".
2. **A cheap discriminator first.** If the outcome is decided per boot, the boot in use is either
   good or bad and a run of trials is all-green or all-red; a mixed run refutes the per-boot model
   immediately.
3. **Instrumentation is the only route to the cause.** Record, per agent, whether `agent/created`
   reached the row, what `belongsToComposition` returned, whether `installScoped()` ran or threw,
   whether the `ctx.inject([...])` callback executed, and whether `tools.register()` happened. The
   cheaper half is dsh's stdout: when the roster swallows a listener failure after a re-link it
   writes exactly one line —
   `agent-presets: tools/change listener failed after recomposing an Agent: …`
   (`dsh-agent-presets/lib/index.js:1704-1708`). Its presence separates "an exception was
   swallowed" from "the loop aborted".
4. **Record boot identity** (the profile's `cordis.yml` mtime, or the process start time) in every
   future observation. Without it, the shared session tree cannot be attributed at all.
