/**
 * Feature-branch naming.
 *
 * Requirement: when the session's intent is already legible, pick a name from
 * it; when it is not, ask the human. This module owns the first half — turning a
 * sentence into a branch name — and answers `undefined` as its "I cannot tell"
 * signal, which is what makes the second half reachable rather than a fallback
 * that never fires.
 *
 * The asymmetry worth knowing: a Latin-script intent yields a slug, a
 * Chinese-only intent usually does not. Transliterating would invent a name the
 * human never wrote and cannot predict, so this module refuses instead, and the
 * caller asks. A wrong-but-plausible branch name is worse than a question.
 *
 * @module @dsh-external/dotdsh-git-flow/branch
 */

/**
 * Verbs that describe the act of changing code rather than its subject.
 *
 * "implement the login redirect" and "login redirect" should name the same
 * branch, so a leading verb is dropped before slugging.
 */
const LEADING_VERBS: ReadonlySet<string> = new Set([
  "add",
  "allow",
  "build",
  "change",
  "create",
  "delete",
  "drop",
  "enable",
  "fix",
  "implement",
  "improve",
  "introduce",
  "make",
  "migrate",
  "move",
  "refactor",
  "remove",
  "rename",
  "replace",
  "rework",
  "support",
  "update",
  "upgrade",
  "use",
  "write",
]);

/** Words that carry no naming value on their own. */
const STOP_WORDS: ReadonlySet<string> = new Set([
  "a",
  "an",
  "and",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

/** Longest branch name this module will produce, leaving room for the prefix. */
const MAX_SLUG_LENGTH = 48;

/** Most words this module will put in a slug. */
const MAX_SLUG_WORDS = 6;

/**
 * Characters a slug can actually be built from.
 *
 * The slug rules below are a Latin-script heuristic: lowercase, hyphenate, drop a
 * leading verb, keep a few words. Applied to a sentence in another script they do
 * not degrade gracefully — they find nothing, or worse, they find whatever Latin
 * token the sentence happened to contain.
 */
const LATIN_LETTER_OR_DIGIT = /[A-Za-z0-9]/gu;

/** Characters that mark a sentence as being written in a non-Latin script. */
const NON_LATIN_LETTER = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

/**
 * Tell whether a sentence is written in a Latin script, so the slug rules apply
 * to its subject rather than to a word it merely mentions.
 *
 * The failure this prevents is specific and was observed in practice. The opening
 * prompt "我需要创建一个插件……你先搜索 github 上是否有完美实现……" is Chinese and is
 * *about* a plugin, but it contains the word `github` — and the slug rules
 * happily turned that one incidental token into the branch `feature/github`. A
 * wrong-but-plausible name is worse than a question, because nobody notices it is
 * wrong; the branch simply gets a meaningless name that outlives the session.
 *
 * Comparing Latin letters against non-Latin ones catches that case while leaving
 * genuinely mixed sentences alone: "add support for 中文 filenames" is a Latin
 * sentence that mentions two foreign characters and still names a branch, whereas
 * "修复 login 跳转" is a Chinese sentence and asks.
 *
 * @param text - the sentence to classify.
 * @returns whether the sentence's own script is Latin.
 */
function isLatinScript(text: string): boolean {
  const nonLatin = (text.match(NON_LATIN_LETTER) ?? []).length;
  if (nonLatin === 0) return true;
  return (text.match(LATIN_LETTER_OR_DIGIT) ?? []).length > nonLatin;
}

/**
 * Reduce one free-form sentence to a branch-name-safe slug.
 *
 * Everything outside `[a-z0-9]` collapses to a single `-`, so the result can
 * never contain a space, a slash, a quote, a leading `-`, or a `..` — the shapes
 * git refuses or that would let a name escape its prefix.
 *
 * @param text - the sentence to reduce.
 * @returns the slug, or `undefined` when nothing nameable survives.
 */
export function slugify(text: string): string | undefined {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .split("-")
    .filter((word) => word !== "");

  if (words.length === 0) return undefined;

  // Drop a leading verb, then stop words, but never drop the last word: a
  // one-word intent such as "refactor" is still a name.
  const afterVerb = LEADING_VERBS.has(words[0]!) && words.length > 1 ? words.slice(1) : words;
  const meaningful = afterVerb.filter((word) => !STOP_WORDS.has(word));
  const chosen = (meaningful.length > 0 ? meaningful : afterVerb).slice(0, MAX_SLUG_WORDS);

  let slug = chosen.join("-");
  if (slug.length > MAX_SLUG_LENGTH) {
    const cut = slug.slice(0, MAX_SLUG_LENGTH);
    const lastDash = cut.lastIndexOf("-");
    slug = lastDash > 0 ? cut.slice(0, lastDash) : cut;
  }
  slug = slug.replace(/^-+|-+$/g, "");

  return slug === "" ? undefined : slug;
}

/**
 * Build a feature-branch name from a session's stated intent.
 *
 * A non-Latin sentence deliberately yields nothing, so the caller asks. The
 * alternative — slugging whatever Latin token it contained — produces a name that
 * looks deliberate and is not, and the human who would have answered the question
 * in one word instead inherits a branch named after a word they only mentioned in
 * passing. Answering is cheap; a meaningless branch name lives in the repository.
 *
 * @param intent - the text the human wrote (a prompt, a summary, or a title).
 * @param prefix - the branch prefix, already including its trailing slash.
 * @returns the full branch name, or `undefined` when the intent yields no slug.
 */
export function branchNameFromIntent(intent: string, prefix: string): string | undefined {
  if (!isLatinScript(intent)) return undefined;
  const slug = slugify(intent);
  return slug === undefined ? undefined : `${prefix}${slug}`;
}

/**
 * Tell whether a branch name already carries the configured prefix.
 *
 * @param branch - the branch name to test.
 * @param prefix - the branch prefix, including its trailing slash.
 * @returns whether `branch` starts with `prefix` and has a name after it.
 */
export function hasBranchPrefix(branch: string, prefix: string): boolean {
  return branch.startsWith(prefix) && branch.length > prefix.length;
}

/**
 * Reduce a branch name to the directory name a worktree should use.
 *
 * A branch such as `feature/add-login` becomes `add-login`: the worktree sits in
 * a directory named for the branch's own name, not for its category, and the
 * result can never contain a slash, so it can never escape the worktree root.
 *
 * @param branch - the full branch name.
 * @param prefix - the branch prefix, including its trailing slash.
 * @returns a single path segment safe to join under the worktree root.
 */
export function worktreeDirectoryName(branch: string, prefix: string): string {
  const withoutPrefix = hasBranchPrefix(branch, prefix) ? branch.slice(prefix.length) : branch;
  return slugify(withoutPrefix) ?? slugify(branch.replace(/\//g, "-")) ?? "worktree";
}
