/**
 * Naming a feature from a session's intent, when the mechanical rules cannot.
 *
 * The requirement is "pick a suitable branch name when the session has said what
 * it is doing, and ask when it has not". The mechanical rules in `branch.ts` do
 * that for a Latin-script prompt: cheap, deterministic, no model call. They cannot
 * do it for a prompt in another script — not because the text is uninformative,
 * but because those rules are looking for Latin words. A Chinese prompt that says
 * exactly what the session is about still yields either nothing or, worse, a lone
 * Latin word it happened to mention.
 *
 * Refusing at that point would throw away the requirement's main path, which is
 * what an earlier version of this plugin did: it saw one bad name
 * (`feature/github`, from a Chinese prompt that mentioned GitHub) and started
 * asking instead of naming. The fix is a second strategy, not a refusal — ask the
 * model, which reads any language and is already running this session.
 *
 * Three properties this module is built around:
 *
 * 1. **The model is consulted last, never first.** A trustworthy mechanical slug
 *    costs nothing and cannot vary between runs; reaching for a model on every
 *    `/git-start` would make a cheap decision slow, non-deterministic and
 *    dependent on a reachable provider.
 * 2. **Model output is input, not a name.** Whatever comes back is re-slugged
 *    through the same rules a human's words go through, so a chatty or decorated
 *    answer cannot become an invalid or surprising ref. Nothing here trusts the
 *    model's formatting.
 * 3. **Every failure is an answer of `undefined`.** A missing route, an
 *    unreachable provider, a timeout, prose instead of a slug — each means "I
 *    could not name this", and the caller asks the human. Nothing throws out of a
 *    pre-write guard because a model was unavailable.
 *
 * @module @dsh-external/dotdsh-git-flow/namer
 */

import { slugify } from "./branch.js";

/**
 * What one naming attempt produced.
 *
 * `unnamed` carries a reason rather than being a bare `undefined`, because "no
 * name" has several causes that need different fixes — no model route, a provider
 * that failed, an answer truncated before it emitted anything, an answer that was
 * prose. Collapsing them cost a debugging session: the harness logger is not
 * visible on every surface a plugin runs on, so the reason has to be able to
 * travel in the one channel that always is — the message the caller shows.
 */
export type NamingAttempt =
  | { readonly kind: "named"; readonly candidate: string }
  | { readonly kind: "unnamed"; readonly reason: string };

/**
 * Produce a branch slug from a session's stated intent.
 *
 * Implementations answer with a candidate — it may be prose, decorated, or empty —
 * and the caller re-slugs it, or with the reason they produced none.
 */
export type IntentNamer = (intent: string, signal?: AbortSignal) => Promise<NamingAttempt>;

/** Longest candidate this module will look at, so a runaway answer cannot be slugged into nonsense. */
const CANDIDATE_MAX_CHARS = 200;

/**
 * Most words an answer may have and still be treated as a name.
 *
 * This is the guard against a second, subtler version of the same mistake the
 * whole naming path exists to avoid. A model that declines — "I am not sure what
 * to call this" — produces a sentence whose words slugify perfectly well into
 * `i-am-not-sure-what-call`: not merely a bad name but a meaningless one, built
 * from the model's own filler. The slug rules cannot tell a name from a sentence,
 * so the length of the answer does it instead. The prompt asks for two to five
 * words and this allows six, so a compliant answer always fits and a sentence
 * rarely does.
 *
 * The boundary this leaves is stated rather than hidden: a *short* prose answer
 * ("no, not that") is indistinguishable from a short name without asking a model
 * to judge its own answer, and would be accepted. That is a residual risk, not an
 * oversight.
 */
const CANDIDATE_MAX_WORDS = 6;

/**
 * Turn a namer's answer into a slug, discarding everything that is not one.
 *
 * A model asked for a branch name may answer with a sentence, wrap the answer in
 * backticks, label it (`Branch name: …`), or add a trailing explanation. Taking
 * the first non-empty line and re-running the slug rules absorbs all of that: the
 * result can only ever be `[a-z0-9-]`, which is what makes it safe to hand to
 * `git` and to a path join.
 *
 * @param candidate - the raw answer.
 * @returns the slug, or `undefined` when nothing usable is in the answer.
 */
export function slugFromCandidate(candidate: string | undefined): string | undefined {
  if (candidate === undefined) return undefined;

  for (const rawLine of candidate.slice(0, CANDIDATE_MAX_CHARS).split("\n")) {
    const line = rawLine
      .trim()
      // Decoration a model reaches for even when told not to.
      .replace(/^[`*_"'“”‘’\s]+/, "")
      .replace(/[`*_"'“”‘’\s.!,;]+$/, "")
      // A labelled answer still states the name after the colon.
      .replace(/^(?:branch(?:\s+name)?|name|slug)\s*[:=]\s*/i, "")
      .trim();
    if (line === "") continue;
    // Reject prose before slugging it: a sentence must not become a name just
    // because its words survive the slug alphabet.
    if (line.split(/\s+/).length > CANDIDATE_MAX_WORDS) continue;
    if (/[.!?]/.test(line)) continue;
    const slug = slugify(line);
    if (slug !== undefined) return slug;
  }
  return undefined;
}

/**
 * Drop a leading repetition of the branch prefix's own word.
 *
 * A model asked to name a git feature branch may reasonably answer
 * `feature/login-redirect`, and the caller then adds the configured prefix —
 * producing `feature/feature-login-redirect`. The prefix is the plugin's
 * business, so a candidate that already carries it is trimmed back to the part
 * that is actually the name.
 *
 * The word is never removed if that would empty the slug: a branch called exactly
 * `feature` is a poor name, but it is still a name, and silently turning it into
 * nothing would send a nameable session back to the human.
 *
 * @param slug - the slug produced from a candidate.
 * @param prefix - the configured branch prefix, e.g. `feature/`.
 * @returns the slug without the repeated prefix word.
 */
export function stripPrefixWord(slug: string, prefix: string): string {
  const word = slugify(prefix.replace(/\/+$/, "").split("/").pop() ?? "");
  if (word === undefined || slug === word) return slug;
  return slug.startsWith(`${word}-`) ? slug.slice(word.length + 1) : slug;
}

/**
 * The instruction given to the model.
 *
 * It asks for the smallest possible answer, states the alphabet, and forbids the
 * things models add by reflex — not because {@link slugFromCandidate} cannot
 * absorb them, but because a shorter answer is cheaper and leaves less to absorb.
 * The line about words "mentioned in passing" is the one that matters here: it is
 * what turns the Chinese prompt that produced `feature/github` into a name about
 * the plugin instead of a name about GitHub.
 *
 * @param intent - the session's stated intent.
 * @returns the user-role text to send.
 */
export function namingPrompt(intent: string): string {
  return [
    "Name the git feature branch for the work described below.",
    "",
    "Rules:",
    "- 2 to 5 words, kebab-case, lowercase ASCII letters, digits and hyphens only.",
    "- Describe the work itself, not the act of doing it: 'login-redirect', not 'implement-login-redirect'.",
    "- Do not use generic words such as 'feature', 'update', 'changes' or 'work'.",
    "- Ignore words that are only mentioned in passing and are not part of the subject.",
    "- Reply with the name alone. No quotes, no backticks, no explanation, no trailing period.",
    "",
    "Work:",
    intent,
  ].join("\n");
}

/** The system slot sent alongside {@link namingPrompt}. */
export const NAMING_SYSTEM = "You name git branches. Reply with one kebab-case slug and nothing else.";
