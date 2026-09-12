/**
 * The git client: one runner seam, plus the small vocabulary every other module
 * speaks.
 *
 * The runner is injected rather than imported so that this plugin has exactly
 * one process-spawning site in production and none in its tests:
 *
 * - **In the harness** the runner is built on `ctx.subprocess`, whose
 *   `spawn({ argv })` is *never shell-interpreted*. That matters more here than
 *   anywhere else in the plugin: a branch name, a path and — above all — a
 *   commit message are model- and human-supplied strings, and building a command
 *   line out of them would let a quote or a `$(…)` change what runs. Passing
 *   every argument as its own argv element makes that class of bug impossible
 *   rather than merely unlikely.
 * - **In the committed tests** the runner is `nodeRunner`, a plain
 *   `node:child_process` spawn, so `pnpm test` needs no harness, no profile and
 *   no network to exercise the whole git workflow against a scratch repository.
 *
 * The trade-off this seam accepts, stated plainly: `ctx.subprocess.spawn` takes
 * an `argv`, while the confinement that `ctx.shell` can apply takes a command
 * *string*. This plugin chooses argv-exactness and does not confine the git
 * child. The work it does is inside the session's own workspace and repository,
 * and it is reached only through an explicit human command.
 *
 * @module @dsh-external/dotdsh-git-flow/exec
 */

import { spawn } from "node:child_process";

/** One finished process. */
export interface RunResult {
  /** Exit code; `-1` when the child was killed by a signal instead of exiting. */
  readonly code: number;
  /** Decoded standard output. */
  readonly stdout: string;
  /** Decoded standard error. */
  readonly stderr: string;
}

/** Anything that can run one process and report its result. */
export type Runner = (
  argv: readonly [string, ...string[]],
  options: {
    readonly cwd: string;
    readonly signal?: AbortSignal;
    readonly env?: Readonly<Record<string, string>>;
  },
) => Promise<RunResult>;

/** Per-call options for one git invocation. */
export interface GitCallOptions {
  /** Cancellation owned by the caller. */
  readonly signal?: AbortSignal;
  /** Environment entries layered over the runner's own. */
  readonly env?: Readonly<Record<string, string>>;
}

/** A git invocation that exited non-zero. */
export class GitError extends Error {
  /** The arguments as passed, without the program name. */
  readonly args: readonly string[];
  /** The captured exit code. */
  readonly code: number;
  /** The captured standard error, trimmed. */
  readonly stderr: string;

  constructor(args: readonly string[], result: RunResult) {
    const detail = result.stderr.trim() || result.stdout.trim() || "no output";
    super(`git ${args.join(" ")} failed (exit ${result.code}): ${detail}`);
    this.name = "GitError";
    this.args = args;
    this.code = result.code;
    this.stderr = result.stderr.trim();
  }
}

/**
 * Environment forced onto every git invocation.
 *
 * `LC_ALL=C` keeps git's own messages stable enough to quote back to a human;
 * `GIT_TERMINAL_PROMPT=0` turns a missing credential into an immediate failure
 * instead of a process waiting on a terminal that will never answer;
 * `GIT_OPTIONAL_LOCKS=0` stops read-only commands such as `status` from taking
 * the index lock just to refresh it, which is what lets a guard run git while
 * another session is mid-commit.
 */
export const GIT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
  LC_ALL: "C",
};

/** Git, bound to one working directory. */
export interface Git {
  /** The directory git runs in. */
  readonly cwd: string;
  /**
   * Run git and return the raw result, including on failure.
   *
   * @param args - git's arguments.
   * @param options - optional cancellation and environment extras.
   * @returns the exit code and both decoded streams.
   */
  run(args: readonly string[], options?: GitCallOptions): Promise<RunResult>;
  /**
   * Run git and return its trimmed stdout.
   *
   * @param args - git's arguments.
   * @param options - optional cancellation and environment extras.
   * @returns the trimmed standard output.
   * @throws GitError when git exits non-zero.
   */
  text(args: readonly string[], options?: GitCallOptions): Promise<string>;
  /**
   * Run git and report whether it succeeded, discarding all output.
   *
   * This is the predicate form for the many git questions whose answer is an
   * exit code: `merge-base --is-ancestor`, `check-ignore`, `diff --quiet`,
   * `rev-parse --verify`.
   *
   * @param args - git's arguments.
   * @param options - optional cancellation.
   * @returns whether git exited zero.
   */
  ok(args: readonly string[], options?: GitCallOptions): Promise<boolean>;
  /**
   * The same runner aimed at another working directory.
   *
   * This is how the plugin performs a merge in the tree that has the integration
   * branch checked out, which may be a different working tree from the caller's.
   *
   * @param cwd - the directory git should run in.
   * @returns a git client bound to `cwd`.
   */
  withCwd(cwd: string): Git;
}

/**
 * Bind a runner to a working directory as a {@link Git}.
 *
 * @param runner - the process runner to use.
 * @param cwd - the directory git runs in.
 * @returns a git client over `runner`.
 */
export function gitClient(runner: Runner, cwd: string): Git {
  const call = (args: readonly string[], options?: GitCallOptions): Promise<RunResult> =>
    runner(["git", ...args], {
      cwd,
      env: { ...GIT_ENV, ...options?.env },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });

  return {
    cwd,
    run: (args, options) => call(args, options),
    async text(args, options) {
      const result = await call(args, options);
      if (result.code !== 0) throw new GitError(args, result);
      return result.stdout.trim();
    },
    async ok(args, options) {
      return (await call(args, options)).code === 0;
    },
    withCwd: (next) => gitClient(runner, next),
  };
}

/**
 * The standalone runner: `node:child_process` with no shell.
 *
 * Exported for the committed tests and for any caller that has no harness
 * `ctx.subprocess` at hand. Production code inside a profile uses the
 * `ctx.subprocess`-backed runner instead, which additionally scopes the child to
 * the harness's teardown and env hygiene.
 *
 * @param argv - the executable followed by its arguments, passed verbatim.
 * @param options - cwd, cancellation, and environment extras.
 * @returns the exit code and both decoded streams.
 */
export const nodeRunner: Runner = (argv, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
