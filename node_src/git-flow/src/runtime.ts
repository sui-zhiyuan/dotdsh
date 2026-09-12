/**
 * The plugin's shared runtime: the one process seam, the state cache, and the
 * resolved settings, threaded through the command and guard layers.
 *
 * ## One process seam, and which one
 *
 * The runner is built on `ctx.subprocess`, whose `spawn({ argv })` is never
 * shell-interpreted. That is the deciding property for this plugin: a branch
 * name, a path and above all a commit message are human- and model-supplied
 * strings, and building a command line out of them would let a quote or a `$(…)`
 * change what runs.
 *
 * The harness offers a higher-level seam, `ctx.shell`, which can additionally
 * apply a sandbox confine — but it takes a command *string*, so choosing it would
 * mean quoting every argument by hand and re-introducing exactly the class of bug
 * argv passing removes. This plugin takes argv-exactness instead, and does not
 * confine its git children.
 *
 * The `.gitignore` write is not routed through `ctx.fs` either, for a related
 * reason: the plugin's file mutation is dominated by git subprocesses, which
 * write the repository directly and are not sandbox-confined by the choice above,
 * so fencing one `.gitignore` write would not be a boundary — it would only be an
 * inconsistency. It would also be a hazard: `dsh-fs-sandbox` falls back to the
 * *deployment* policy when no session policy is passed, which would refuse a
 * write the session itself is entitled to make. `FileAccess` remains a seam, so
 * this is a decision that can be reversed in one place rather than scattered.
 *
 * @module @dsh-external/dotdsh-git-flow/runtime
 */

import {
  createUserMessage,
  ReasoningEffortId,
  type GenerateOptions,
  type StreamChunk,
} from "@deepseek-ai/dsh-llm";
import type { SubprocessRuntime } from "@deepseek-ai/dsh-subprocess";
// Type-only, and deliberately value-free: these packages are what declare
// `Context.llm` and `Context.agentDefaultModel`. The services themselves arrive
// through `ctx.inject` below, so neither becomes a precondition for this plugin
// activating — a profile without them simply gets a flow that asks for a name.
import type {} from "@deepseek-ai/dsh-agent-default-model";
import type {} from "@deepseek-ai/dsh-llm";
import type { ClaimLatch } from "./claim.js";
import type { Runner } from "./exec.js";
import type { FlowConfig } from "./flow.js";
import { NAMING_SYSTEM, namingPrompt, type IntentNamer, type NamingAttempt } from "./namer.js";
import type { AgentLike, SessionRegistryLike } from "./session.js";
import type { GitFlowState } from "./state.js";

/** Per-call output cap for a git child, above which the harness spills to a file. */
const STDOUT_MAX_BYTES = 1 << 20;

/** Per-call spilled-output cap. */
const SPILL_MAX_BYTES = 8 << 20;

/** Grace period between SIGTERM and SIGKILL when a git child is cancelled. */
const GRACE_MS = 5_000;

/** What a `tools/pre-execute` gate does when the integration branch is checked out. */
export type GuardMode = "auto-start" | "block" | "off";

/**
 * The fully-resolved settings, as every layer reads them.
 *
 * It extends the flow settings rather than sitting beside them so the flow layer
 * keeps depending only on what it uses, while the command and guard layers get one
 * object that is already defaulted and already validated — no layer re-derives a
 * default, and there is no partially-filled shape to cast away.
 */
export interface ResolvedConfig extends FlowConfig {
  /** What the pre-write guard does on the integration branch. */
  readonly guard: GuardMode;
  /** Whether the guard also covers the Bash tool. */
  readonly guardBash: boolean;
}

/** What the command and guard layers need from the plugin's lifetime. */
export interface Runtime {
  /** The process seam every git invocation goes through. */
  readonly runner: Runner;
  /** The session state cache. */
  readonly state: GitFlowState;
  /** The resolved settings. */
  readonly config: ResolvedConfig;
  /** Where the plugin reports what it did, or could not do. */
  log?: NamingLog;
  /**
   * Builds the model-backed namer for one agent.
   *
   * A factory rather than a namer because the route is per-agent, and mutable
   * because it is installed by an optional scoped injection: the capability
   * appears when the host exposes a model, and never holds up the plugin.
   */
  namerFor?: (agent: AgentLike) => IntentNamer;
  /** This process's id, recorded in the ledger so dead sessions can be pruned. */
  readonly pid: number;
  /**
   * The per-process claim skip.
   *
   * A cache with no authority over the ledger: it keeps a once-per-family write out
   * of a gate that runs on every file-mutating call, and its loss is a cache miss.
   */
  readonly latch: ClaimLatch;
  /**
   * The session registry, used to follow a delegation chain to its root. Every
   * decision is keyed by that root, so a subagent and its parent are one workflow
   * rather than two.
   */
  readonly sessions: SessionRegistryLike;
}

/**
 * Build the harness-backed runner.
 *
 * `ctx.subprocess.spawn` has no defaults: it requires a `cwd`, all three stdio
 * dispositions and a `graceMs`, and it throws synchronously when the signal is
 * already aborted. The collector keeps the child's output readable after exit,
 * which is when this runner reads it — git's output is only complete once the
 * process is gone.
 *
 * @param subprocess - the injected subprocess service.
 * @returns a runner that never shell-interprets its arguments.
 */
export function subprocessRunner(subprocess: SubprocessRuntime): Runner {
  return async (argv, options) => {
    const collect = { maxBytes: STDOUT_MAX_BYTES, spill: { maxBytes: SPILL_MAX_BYTES } };
    const handle = subprocess.spawn({
      argv,
      cwd: options.cwd,
      stdio: {
        // Every git command this plugin runs is non-interactive by construction:
        // `GIT_TERMINAL_PROMPT=0` (see `exec.ts`) turns a missing credential into a
        // failure rather than a prompt, so there is never anything to type.
        stdin: "ignore",
        stdout: collect,
        stderr: collect,
      },
      graceMs: GRACE_MS,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.env === undefined ? {} : { env: { ...options.env } }),
    });

    const outcome = await handle.done;
    const stdout = handle.collected.stdout?.readFrom(0).text ?? "";
    const stderr = handle.collected.stderr?.readFrom(0).text ?? "";
    // A child killed by a signal reports a null exit code; `-1` keeps the result
    // shape total rather than making every caller handle null.
    return { code: outcome.exitCode ?? -1, stdout, stderr };
  };
}

/**
 * The slice of the host a naming call needs.
 *
 * Structural on purpose: the real `Context` satisfies it, and so does a fake, so
 * the model path can be exercised by the committed checks rather than only by a
 * live session.
 */
export interface NamingHost {
  /** The model service. */
  readonly llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> };
  /** The configured default model selection. */
  readonly agentDefaultModel: { currentSelection(): { readonly provider: string; readonly model: string } };
}

/** How long a naming call may take before the flow gives up and asks instead. */
const NAMING_TIMEOUT_MS = 20_000;

/**
 * Token budget for one name.
 *
 * 64, not the handful a slug needs, because the budget pays for the model's
 * *reasoning* before its answer. A reasoning model given 32 tokens can spend all
 * of them thinking and be cut off with nothing emitted at all — which arrives as a
 * `max-tokens` finish with no text, indistinguishable at this end from a provider
 * that simply failed. The harness's own equivalent call (a five-word session
 * title) uses this same 64, which is the number to match rather than guess below.
 */
const NAMING_MAX_TOKENS = 64;

/** The two severities this module reports through. */
export interface NamingLog {
  /** A naming attempt succeeded. */
  info(message: string): void;
  /** A naming attempt produced nothing usable. */
  warn(message: string): void;
}

/** The plugin name recorded as the source of the naming message. */
const NAMING_SOURCE = "git-flow";

/**
 * Resolve the provider route and model to name with.
 *
 * The session's own logged request route comes first — it is the model this
 * session is actually running on, it is what the harness's own auxiliary callers
 * read (`dsh-compaction-basic` does exactly this), and unlike an agent's
 * configured options it reflects a model the human switched to mid-session.
 *
 * The configured default is the fallback for a session that has not made a request
 * yet, and the agent's own options are the last resort: they are optional *and*
 * overridable per request, so they describe intent rather than fact.
 *
 * A host exposing none of the three yields `undefined`, which is a legitimate
 * answer — the flow asks the human — and never an error.
 *
 * @param ctx - a context carrying `agentDefaultModel`.
 * @param agent - the agent whose branches are being named.
 * @returns the route, or `undefined` when nothing can be resolved.
 */
function modelSelectionOf(
  ctx: NamingHost,
  agent: AgentLike,
): { readonly provider: string; readonly model: string } | undefined {
  const logged = agent.session.requestHeader?.()?.config;
  if (logged !== undefined && logged.provider !== "" && logged.model !== "") {
    return { provider: logged.provider, model: logged.model };
  }

  try {
    const fallback = ctx.agentDefaultModel.currentSelection();
    if (fallback.provider !== "" && fallback.model !== "") {
      return { provider: fallback.provider, model: fallback.model };
    }
  } catch {
    // A host without a readable default is not an error here: the flow asks.
  }

  const own = agent.options;
  if (own?.provider !== undefined && own.provider !== "" && own.model !== undefined && own.model !== "") {
    return { provider: own.provider, model: own.model };
  }
  return undefined;
}

/**
 * Build the model-backed namer for one agent.
 *
 * Every failure path returns `undefined` rather than throwing, because the caller
 * is a pre-write gate: a plugin must not turn an unreachable provider into a
 * failed file edit. The call is bounded by the caller's signal **and** its own
 * timeout, so a slow provider delays one branch name and not a turn.
 *
 * Only `text-delta` chunks are collected. A model that answers by calling a tool,
 * or that finishes with no text at all, has not named anything — which is an
 * answer of `undefined`, not an error to report.
 *
 * @param ctx - a context carrying both `llm` and `agentDefaultModel`.
 * @param agent - the agent whose branches are being named.
 * @param timeoutMs - how long to wait before treating the call as unanswered.
 * @param log - where to report the outcome. A capability that fails closed and
 *   silently is undebuggable: every unusable answer says which way it failed, so a
 *   broken route or an exhausted budget is visible in the harness log instead of
 *   looking exactly like a model that had no opinion.
 * @returns a namer that answers with raw text for the caller to slug.
 */
export function createModelNamer(
  ctx: NamingHost,
  agent: AgentLike,
  timeoutMs: number = NAMING_TIMEOUT_MS,
  log?: NamingLog,
): IntentNamer {
  // Two attempts, and the order is the point.
  //
  // The first asks for no reasoning at all. Naming a branch needs none, and the
  // budget is what pays for it: the adapter disables thinking only for
  // `purpose: 'session-title'` (a purpose this call is not and must not pretend to
  // be), so left to itself the model spends the whole allowance on a monologue and
  // is cut off before it emits a single character of the answer — observed, as
  // `finish: max-tokens` with no text. Asking explicitly is the difference between
  // a budget spent on a slug and one spent on thinking about a slug.
  //
  // The second attempt drops the hint, for an adapter that does not accept it. It
  // runs only after the first produced nothing, so the fast path stays one call.
  const attempts: readonly (ReasoningEffortId | undefined)[] = [ReasoningEffortId("off"), undefined];
  const perAttemptMs = Math.max(1, Math.floor(timeoutMs / attempts.length));

  return async (intent, signal): Promise<NamingAttempt> => {
    const selection = modelSelectionOf(ctx, agent);
    if (selection === undefined) {
      const reason = "no model route is available (the session has made no request and no default is configured)";
      log?.warn(`git-flow: ${reason}`);
      return { kind: "unnamed", reason };
    }

    let last: NamingAttempt = { kind: "unnamed", reason: "no naming attempt was made" };
    for (const [index, effort] of attempts.entries()) {
      last = await oneNamingAttempt(ctx, agent, selection, intent, signal, perAttemptMs, effort, log);
      if (last.kind === "named") return last;
      if (index + 1 < attempts.length) {
        log?.warn(`git-flow: ${last.reason}; retrying with the model's default reasoning`);
      }
    }
    return last;
  };
}

/**
 * Make one bounded naming call and read its text.
 *
 * Every failure path answers `unnamed` with a reason rather than throwing, because
 * the caller is a pre-write gate: a plugin must not turn an unreachable provider
 * into a failed file edit. Only `text-delta` chunks are collected — a model that
 * answers by calling a tool, or that finishes with no text at all, has not named
 * anything, which is an answer, not an error to report.
 *
 * @param ctx - the host.
 * @param agent - the agent whose branches are being named.
 * @param selection - the resolved provider route.
 * @param intent - the session's stated intent.
 * @param signal - cancellation owned by the caller.
 * @param timeoutMs - this attempt's own budget.
 * @param effort - the reasoning effort to ask for, or `undefined` for the model's default.
 * @param log - where to report the outcome.
 * @returns the candidate text, or the reason there is none.
 */
async function oneNamingAttempt(
  ctx: NamingHost,
  agent: AgentLike,
  selection: { readonly provider: string; readonly model: string },
  intent: string,
  signal: AbortSignal | undefined,
  timeoutMs: number,
  effort: ReasoningEffortId | undefined,
  log?: NamingLog,
): Promise<NamingAttempt> {
  const deadline = AbortSignal.any([
    ...(signal === undefined ? [] : [signal]),
    AbortSignal.timeout(timeoutMs),
  ]);

  try {
    const messages = [
      createUserMessage({
        content: [{ type: "text", text: namingPrompt(intent) }],
        source: { kind: "plugin", plugin: NAMING_SOURCE },
      }),
    ];
    let text = "";
    // The finish reason is kept, not discarded: it is the difference between "the
    // model said nothing" and "the model was cut off mid-thought", and only one of
    // those is worth reporting to the human.
    let finish: string | undefined;
    for await (const chunk of ctx.llm.stream({
      provider: selection.provider,
      model: selection.model,
      system: NAMING_SYSTEM,
      messages,
      maxTokens: NAMING_MAX_TOKENS,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
      // `sessionId` is deliberately omitted. Passing it makes
      // `dsh-session-checkpoint-policy` flush the durable session log before
      // dispatch — a real side effect, on the pre-write path, for a call whose
      // answer is a two-word branch name.
      signal: deadline,
    })) {
      if (chunk.type === "text-delta") text += chunk.text ?? "";
      else if (chunk.type === "finish") finish = finishReasonOf(chunk.reason);
    }

    if (text === "") {
      const reason =
        `the naming call on ${selection.provider}/${selection.model} produced no text` +
        (finish === undefined ? " and no finish reason" : ` (finish: ${finish})`);
      log?.warn(`git-flow: ${reason}`);
      return { kind: "unnamed", reason };
    }
    log?.info(`git-flow: named a feature with ${selection.provider}/${selection.model} (finish: ${finish ?? "none"})`);
    return { kind: "named", candidate: text };
  } catch (error) {
    const reason = `the naming call to ${selection.provider}/${selection.model} failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
    log?.warn(`git-flow: ${reason}`);
    return { kind: "unnamed", reason };
  }
}

/**
 * Reduce a finish reason to something readable in a log.
 *
 * `FinishReason` is a tagged union and only some of its variants mean the answer
 * is complete; everything else is a reason the naming call produced nothing, which
 * is exactly what a reader of the log needs to see.
 *
 * @param reason - the reason a stream ended.
 * @returns its tag, or a fallback when the shape is not what was expected.
 */
function finishReasonOf(reason: unknown): string {
  if (typeof reason === "object" && reason !== null && "kind" in reason) {
    return String((reason as { kind: unknown }).kind);
  }
  return "unknown";
}
