/**
 * The ignore guard: make the worktree root ignored *before* anything is created
 * inside it, and prove it afterwards.
 *
 * Why this exists, precisely. A `git worktree add` inside the repository creates
 * a directory containing a `.git` **file**. Git recognises that as an embedded
 * repository, and a `git add --all` run from the main tree does not stage the
 * thousands of files inside — it stages **one** entry: a gitlink (mode `160000`)
 * recording the worktree's HEAD commit id. That is arguably worse than a file
 * flood, because it is silent, it survives review as a single innocuous-looking
 * line, and it points at a commit that stops being reachable the moment
 * `/git-complete` removes the worktree and its branch. A clone of the outer
 * repository can never reproduce it, there is no `.gitmodules`, and this
 * plugin's own per-step commits would happily commit it for you.
 *
 * The guard is written to `.gitignore` rather than `.git/info/exclude` on
 * purpose: the rule is part of how the repository is meant to be worked on, it
 * should be reviewed and shared like any other convention, and a comment above
 * it explains to the next reader — human or agent — why the line is there.
 *
 * Three properties this module is built around:
 *
 * 1. **Before, not after.** The entry is written before `git worktree add`, so
 *    the window in which an unprotected linked repository exists is empty.
 * 2. **Verified, not assumed.** Writing a line is not the same as being ignored.
 *    A parent `.gitignore`, a `!.dsh/` negation, or a `core.excludesFile` can all
 *    defeat the entry, so the guard re-asks git with `check-ignore` and fails
 *    loudly instead of leaving a repository that only looks protected.
 * 3. **Idempotent and additive.** Re-running adds nothing when a tracked rule
 *    already covers the path, and the append preserves the file's own line
 *    endings and its missing final newline.
 *
 * @module @dsh-external/dotdsh-git-flow/ignore
 */

import { resolve, relative, sep } from "node:path";
import type { FileAccess } from "./file-access.js";
import type { Git } from "./exec.js";
import { worktreeList } from "./repo.js";

/** Inputs to one guard run. */
export interface IgnoreGuardOptions {
  /** A client for the repository. */
  readonly git: Git;
  /** The file seam used to read and rewrite `.gitignore`. */
  readonly files: FileAccess;
  /** Absolute path of the directory that must stay ignored. */
  readonly directory: string;
  /** Comment lines placed above the pattern, without leading `#`. */
  readonly comment: readonly string[];
  /** Optional cancellation. */
  readonly signal?: AbortSignal;
}

/** What the guard did, and what it found. */
export interface IgnoreGuardResult {
  /** Whether a rule was required at all — `false` when the directory is outside the repository. */
  readonly needed: boolean;
  /** Absolute path of the `.gitignore` that now covers the directory. */
  readonly gitignorePath: string | undefined;
  /** The pattern that covers the directory. */
  readonly pattern: string | undefined;
  /** Whether `.gitignore` was rewritten by this run. */
  readonly changed: boolean;
  /** The winning rule as `git check-ignore -v` reported it. */
  readonly rule: string | undefined;
  /**
   * Whether git already tracks something at this path in the index.
   *
   * `true` means an earlier run — or another tool — already staged the worktree
   * directory as an embedded repository, and the entry needs removing by hand:
   * `git rm --cached <path>`.
   */
  readonly trackedGitlink: boolean;
}

/** One parsed `git check-ignore -v` line. */
interface IgnoreMatch {
  /** The file the rule came from. */
  readonly source: string;
  /** The rule's pattern text. */
  readonly pattern: string;
  /** The whole line, for reporting. */
  readonly line: string;
}

/**
 * Ask git which rule, if any, ignores a path.
 *
 * `--no-index` is required: without it git skips paths it already tracks, which
 * would hide exactly the broken state this guard exists to prevent.
 *
 * @param git - a client for the repository.
 * @param path - absolute path to test.
 * @returns the winning rule, or `undefined` when nothing ignores the path.
 */
async function checkIgnore(git: Git, path: string, signal?: AbortSignal): Promise<IgnoreMatch | undefined> {
  const result = await git.run(["check-ignore", "-v", "--no-index", "--", path], {
    ...(signal === undefined ? {} : { signal }),
  });
  if (result.code !== 0) return undefined;

  const [rulePart] = result.stdout.trim().split("\t");
  if (rulePart === undefined) return undefined;
  const parsed = /^(.*):(\d+):(.*)$/.exec(rulePart);
  if (parsed === null) return undefined;
  return { source: parsed[1]!, pattern: parsed[3]!, line: rulePart };
}

/**
 * Tell whether a rule source is a tracked `.gitignore` rather than a local-only
 * or machine-global exclude file.
 *
 * @param source - the source path git reported.
 * @returns whether the rule lives in a `.gitignore`.
 */
function isGitignoreSource(source: string): boolean {
  return source === ".gitignore" || source.endsWith(`${sep}.gitignore`) || source.endsWith("/.gitignore");
}

/**
 * Detect the line ending a file already uses, so an append does not turn one
 * line into a spurious diff.
 *
 * @param content - the file's current contents.
 * @returns the line ending to use for appended lines.
 */
function detectEol(content: string): string {
  const crlf = content.split("\r\n").length - 1;
  const lf = content.split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

/**
 * Build the text to append, keeping the file's line endings and starting on a
 * fresh line even when the file does not end in a newline.
 *
 * @param existing - the file's current contents, or `undefined` when absent.
 * @param comment - comment lines, without leading `#`.
 * @param pattern - the pattern line.
 * @returns the text to append.
 */
function appendBlock(existing: string | undefined, comment: readonly string[], pattern: string): string {
  if (existing === undefined || existing === "") {
    return `${[...comment.map((line) => `# ${line}`), pattern].join("\n")}\n`;
  }

  const eol = detectEol(existing);
  const endsWithNewline = existing.endsWith("\n");
  const endsWithBlankLine = /(\r?\n){2}$/.test(existing);
  const normalized = existing.replace(/\r\n/g, "\n").replace(/\n/g, eol);

  let prefix = endsWithNewline ? "" : eol;
  if (endsWithNewline && !endsWithBlankLine) prefix += eol;
  return `${normalized}${prefix}${[...comment.map((line) => `# ${line}`), pattern].join(eol)}${eol}`;
}

/**
 * Ensure a directory is ignored, proving it with git before returning.
 *
 * @param options - the repository, file seam, directory, and comment.
 * @returns what the guard found and whether it had to change anything.
 * @throws Error when the directory is inside the repository but git still does
 *   not ignore it after the entry was written — almost always a negation rule
 *   or a parent-level rule, both of which need a human decision.
 */
export async function ensureIgnored(options: IgnoreGuardOptions): Promise<IgnoreGuardResult> {
  const { git, files, directory, comment, signal } = options;

  // The rule has to live in the main tree's `.gitignore`: that is the file the
  // repository tracks, and relative patterns in it are resolved from there.
  const trees = await worktreeList(git);
  const mainTree = trees[0]?.path ?? git.cwd;

  const relativeDirectory = relative(mainTree, directory).split(sep).join("/");
  if (relativeDirectory === "" || relativeDirectory.startsWith("..")) {
    return {
      needed: false,
      gitignorePath: undefined,
      pattern: undefined,
      changed: false,
      rule: undefined,
      trackedGitlink: false,
    };
  }

  const pattern = `${relativeDirectory}/`;
  const probe = resolve(mainTree, relativeDirectory, ".dsh-git-flow-probe");
  const gitignorePath = resolve(mainTree, ".gitignore");

  // Any index entry at mode 160000 under this directory is the exact damage the
  // guard prevents, arriving before the guard did. It cannot be repaired by an
  // ignore rule — an ignore rule never affects an already-tracked path — so it is
  // reported for a human to undo with `git rm --cached`.
  const tracked = await git.text(["ls-files", "-s", "--", relativeDirectory]).catch(() => "");
  const trackedGitlink = tracked
    .split("\n")
    .some((line) => line.startsWith("160000"));

  const before = await checkIgnore(git, probe, signal);
  if (before !== undefined && isGitignoreSource(before.source)) {
    return {
      needed: true,
      gitignorePath,
      pattern,
      changed: false,
      rule: before.line,
      trackedGitlink,
    };
  }

  const existing = await files.read(gitignorePath, signal);
  const alreadyListed = existing
    ?.replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => line.trim() === pattern);

  if (!alreadyListed) {
    await files.write(gitignorePath, appendBlock(existing, comment, pattern), signal);
  }

  // Verification is the point of the guard. A line in the file is a claim; this
  // is the proof, and it is the only thing that catches a `!` rule above it or a
  // broader ignore that a parent directory already decided.
  const after = await checkIgnore(git, probe, signal);
  if (after === undefined) {
    throw new Error(
      `git still does not ignore ${relativeDirectory}/ after adding the rule to ${gitignorePath}. ` +
        "A negation rule (a later `!…` line) or a rule in a parent directory is overriding it. " +
        `Refusing to create a worktree that another session's \`git add --all\` could stage as an embedded repository.`,
    );
  }

  return {
    needed: true,
    gitignorePath,
    pattern,
    changed: !alreadyListed,
    rule: after.line,
    trackedGitlink,
  };
}

/**
 * The comment this plugin writes above its `.gitignore` entry.
 *
 * It is addressed at whoever reads the diff next — including another agent
 * working in the same repository — so it states the failure it prevents rather
 * than only the rule it adds.
 *
 * @param directory - the repository-relative directory being ignored.
 * @returns the comment lines, without leading `#`.
 */
export function ignoreComment(directory: string): readonly string[] {
  return [
    `dsh git-flow: per-session git worktrees live under ${directory}/.`,
    "Each one is a linked git repository: without this rule a `git add --all`",
    "would stage it as an embedded repository (a gitlink) pointing at a commit",
    "that disappears when the worktree is removed. Keep this ignored.",
  ];
}
