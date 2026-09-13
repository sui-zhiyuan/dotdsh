/**
 * The tool: one `ssh_run`, the model's way to drive a server the lazy way.
 *
 * There is deliberately one tool and not three. The pool releases connections on
 * its own, so there is nothing to close; there is no credential to manage, so
 * there is nothing to configure. What is left is the one operation the user
 * asked for — run this command on that server — and everything else this plugin
 * does happens behind it.
 *
 * ## Why a call is a string of text
 *
 * Like the rest of this repository's tools, the answer is one text block: what
 * happened, in the terms the model needs to decide what to do next. A remote
 * exit code is part of that answer rather than an error, because a failing
 * command is the normal way to learn something about a server — the model needs
 * to read stderr and the status together. Only three things throw: the caller's
 * own cancellation, a destination that is not one, and ssh not starting at all.
 *
 * ## The rendered shape
 *
 * Stable, because the model reads it and the committed check asserts it:
 *
 * ```text
 * ssh deploy@build-01: exit 0 (reused connection, 142 ms)
 * --- stdout ---
 * <standard output, without its final newline>
 * --- stderr ---
 * <standard error, without its final newline>
 * ```
 *
 * The header always carries the destination, the exit status, the connection and
 * the duration; `timed out` and `output truncated` are appended to it when they
 * apply. A stream section appears only when that stream said something, and a
 * call that said nothing at all is followed by `(no output)`.
 *
 * ## Deferred
 *
 * **`ssh_sessions`, a read-only view of what is held open.** It would be the
 * natural way for a human to ask "is anything still connected to that box?", and
 * the pool's connection table is where the answer comes from. It is not in this
 * commit because the user asked for the one tool, and a second tool is a second
 * schema for the model to choose between. When it is wanted, the descriptors live
 * here, the wiring iterates, and the pool gains the view it is asked for.
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` is fair game — and never upward.
 *
 * @module @dsh-external/dotdsh-lazy-ssh/tools
 */

import type { ToolSchema } from "@deepseek-ai/dsh-llm";
import type { ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { SshPool, SshResult } from "../core/pool.js";

/**
 * One tool this file defines: what the model is shown, and what runs the call.
 *
 * Generic in its arguments for the same reason as the other plugin in this
 * repository: a handler that reads `{ server: string }` should say so, while
 * entries with different argument objects still share one list.
 */
export interface SshTool<Args> {
  /** Name, description, and the argument schema the model must satisfy. */
  readonly descriptor: ToolSchema;
  /**
   * Run one accepted call.
   *
   * @param args - the model's own arguments, already validated against the descriptor.
   * @param execution - the call's identity, cancellation, and calling agent.
   * @returns the text the model reads.
   */
  readonly execute: (args: Args, execution: ToolRunContext) => Promise<string>;
}

/** The arguments the `ssh_run` tool accepts. */
export interface SshRunArguments {
  /** The ssh destination, as it would be written on an `ssh` command line. */
  readonly server: string;
  /** The remote command; interpreted by the remote shell. */
  readonly command: string;
  /** This call's deadline in milliseconds, overriding the plugin's default. */
  readonly timeoutMs?: number;
}

/** The `ssh_run` tool, as the model is shown it. */
const SSH_RUN_TOOL: ToolSchema = {
  name: "ssh_run",
  description:
    "Run a command on a remote server over ssh. " +
    "Connections are reused: the first call to a server opens one ssh connection, and later calls to the same server " +
    "run over it until the server has been idle for the configured timeout, so a sequence of calls does not pay the " +
    "TCP handshake and the key exchange over and over. Authentication is whatever your ~/.ssh already does — keys, " +
    "agent, ssh config — and this tool never handles a password. Each call is a new remote shell, so a `cd` does not " +
    "carry over: join steps with `&&` inside one call. A non-zero remote exit status is reported in the result rather " +
    "than raised, so read stdout, stderr and the status together.",
  parameters: {
    server: {
      type: "string",
      required: true,
      description:
        "The ssh destination exactly as you would write it for ssh: `host`, `user@host`, or a Host alias from " +
        "~/.ssh/config. Options are not accepted here; put them in the alias or in the plugin's config.",
    },
    command: {
      type: "string",
      required: true,
      description:
        "The remote command, written as one shell command line. It is interpreted by the remote shell, so quoting and " +
        "`&&` behave as they do in a terminal on that server.",
    },
    timeoutMs: {
      type: "number",
      required: false,
      description:
        "How long this one command may take, in milliseconds. Defaults to the plugin's configured command timeout. " +
        "A command that hits it is killed and reported as timed out.",
    },
  },
};

/**
 * Render one result the way the module header specifies.
 *
 * @param result - the finished call.
 * @returns the text the model reads.
 */
function renderResult(result: SshResult): string {
  throw new Error(`renderResult is not implemented: ${result.destination}`);
}

/**
 * Build every tool this plugin contributes, bound to one pool.
 *
 * A list rather than a single registration, because the wiring module iterates
 * it: adding the deferred `ssh_sessions` later is a change in this file and
 * nowhere else.
 *
 * @param pool - the pool every call goes through.
 * @returns the tools to register, in the order they should be listed.
 */
export function sshTools(pool: SshPool): readonly SshTool<never>[] {
  throw new Error("sshTools is not implemented");
}
