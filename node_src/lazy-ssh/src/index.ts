/**
 * The composition root: what dsh calls when it mounts this plugin.
 *
 * `apply` builds the three pieces in order — the ssh configuration, the pool
 * that owns lifetime, the tools that call it — and registers each contribution
 * under `ctx.effect`, so a reload, a disable or an unmount takes them away
 * again. The plugin's own teardown is part of that: the disposer releases every
 * connection the pool is holding, and a `process.on("exit")` hook covers the
 * shutdowns where nothing asynchronous runs at all.
 *
 * Neither runs under `SIGKILL`, and the boundary that leaves — an abandoned idle
 * master for at most `idleTimeoutMs` plus the control-persist grace, and a call
 * in flight until its remote command ends — is stated in full in
 * `platform/ssh.ts`. It is a documented cost, not an oversight.
 *
 * ## Why the plugin is not per-session
 *
 * The connection a session reuses is exactly the connection another session
 * would want to reuse, so the pool is one per process, not one per agent: two
 * sessions asking for the same server must share the master, and a per-session
 * pool would build a second one the moment a second session was opened. Keeping
 * no session state is also what lets this plugin be mounted as a plain host row.
 *
 * ## Configuration
 *
 * Every key has a default, and a value that cannot work fails the row while it
 * mounts rather than the first call that trips over it:
 *
 * | Key | Default | Meaning |
 * | --- | --- | --- |
 * | `idleTimeoutMs` | `300000` | How long a connection may sit idle before it is released. |
 * | `commandTimeoutMs` | `120000` | Default deadline for one command. |
 * | `connectTimeoutSec` | `10` | `ConnectTimeout`: bounds the handshake, not the command. |
 * | `maxOutputBytes` | `1048576` | Per-stream output cap; past it the stream is truncated. |
 * | `batchMode` | `true` | Pass `-o BatchMode=yes`: an unanswerable prompt fails instead of hanging. |
 * | `sshBinary` | `"ssh"` | The executable to run. |
 * | `sshOptions` | `[]` | Extra ssh arguments, inserted verbatim before the destination. |
 * | `controlDir` | `$TMPDIR/dsh-lazy-ssh-<uid>` | Where the per-server control sockets live. |
 *
 * ## Layer
 *
 * The boundary: dsh calls in here, and this is the only layer that talks to it.
 * References point downward — `core` and `platform` are both fair game — and
 * never upward.
 *
 * @module @dsh-external/dotdsh-lazy-ssh
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool, type ParameterSchemaSpec } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";
import { SshPool } from "./core/pool.js";
import { sshTools } from "./boundary/tools.js";
import { nodeRunner } from "./platform/exec.js";
import { ensureControlDir, SshTransport, type SshConfig } from "./platform/ssh.js";

/** The plugin name, following dsh's convention: the package name minus scope and prefix. */
export const name = "lazy-ssh";

/**
 * The services this plugin registers into.
 *
 * Only `tools`: the plugin publishes nothing and consumes nothing else, because
 * its whole subject — this machine's ssh and this user's `~/.ssh` — is reached
 * through a process, not through the harness.
 */
export const inject = ["tools"];

/** The directory a control socket is placed in when the row names none. */
function defaultControlDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return join(tmpdir(), `dsh-lazy-ssh-${uid}`);
}

/** Lazy-ssh plugin configuration, as the row in the bundle patch writes it. */
export interface Config {
  /** How long a connection may sit idle before the pool releases it. */
  idleTimeoutMs: number;
  /** Default deadline for one command, when the call sets none. */
  commandTimeoutMs: number;
  /** `ConnectTimeout` in seconds. */
  connectTimeoutSec: number;
  /** Per-stream output cap in bytes. */
  maxOutputBytes: number;
  /** Whether to pass `-o BatchMode=yes`. */
  batchMode: boolean;
  /** The ssh executable: an absolute path or a name resolved on `PATH`. */
  sshBinary: string;
  /** Extra ssh arguments, inserted verbatim before the destination. */
  sshOptions: string[];
  /** Where the per-server control sockets live. Created `0700`. */
  controlDir: string;
}

/** Schemastery configuration for the lazy-ssh plugin. */
export const Config: z<Config> = z.object({
  idleTimeoutMs: z.number().default(300_000),
  commandTimeoutMs: z.number().default(120_000),
  connectTimeoutSec: z.number().default(10),
  maxOutputBytes: z.number().default(1 << 20),
  batchMode: z.boolean().default(true),
  sshBinary: z.string().default("ssh"),
  sshOptions: z.array(z.string()).default([]),
  controlDir: z.string().default(defaultControlDir()),
});

/**
 * Resolve the row's config into the ssh configuration the transport speaks.
 *
 * The numeric keys are checked here rather than left to ssh: a negative or
 * fractional timeout is a config mistake, and a row that mounts with one is a
 * row that fails much later, in a call that looks like a network problem.
 *
 * @param config - the validated row config.
 * @returns the transport's view of it.
 * @throws Error naming the key whose value cannot work.
 */
export function resolveSshConfig(config: Config): SshConfig {
  // A duration or a byte count that is not a positive number is a config
  // mistake, and the row that mounts with one should be the thing that fails.
  const positive = (key: string, value: number, integral: boolean): void => {
    const ok = Number.isFinite(value) && value > 0 && (!integral || Number.isInteger(value));
    if (!ok) throw new Error(`${key} must be a positive ${integral ? "integer" : "number"}; got ${value}`);
  };

  positive("idleTimeoutMs", config.idleTimeoutMs, false);
  positive("commandTimeoutMs", config.commandTimeoutMs, false);
  positive("connectTimeoutSec", config.connectTimeoutSec, true);
  positive("maxOutputBytes", config.maxOutputBytes, true);
  if (config.sshBinary.trim() === "") throw new Error("sshBinary must name an executable");
  if (config.controlDir.trim() === "") throw new Error("controlDir must name a directory");

  return {
    sshBinary: config.sshBinary,
    controlDir: config.controlDir,
    connectTimeoutSec: config.connectTimeoutSec,
    idleTimeoutMs: config.idleTimeoutMs,
    batchMode: config.batchMode,
    sshOptions: [...config.sshOptions],
  };
}

/**
 * Register this plugin's contributions.
 *
 * @param ctx - the plugin context, with `tools` injected.
 * @param config - the row's configuration, validated by {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const ssh = resolveSshConfig(config);
  // Fail at the row, where a human sees it, rather than at the first call that
  // needs a socket to exist.
  ensureControlDir(ssh.controlDir);

  const pool = new SshPool(new SshTransport(nodeRunner, ssh), {
    idleTimeoutMs: ssh.idleTimeoutMs,
    commandTimeoutMs: config.commandTimeoutMs,
    maxOutputBytes: config.maxOutputBytes,
  });

  for (const tool of sshTools(pool)) {
    ctx.effect(() =>
      ctx.tools.register(
        defineTool({
          ...tool.descriptor,
          // `ToolSchema` carries the arguments as a bare `Record`, because the LLM
          // layer only ever projects them to JSON Schema. Only here, where they are
          // handed to the registry that compiles and enforces them, is their real
          // author-facing shape known.
          parameters: tool.descriptor.parameters as ParameterSchemaSpec,
          // The declaration `ToolSchema` cannot carry: this tool answers with one
          // text block, which is what the model reads.
          output: {
            schema: { type: "string" },
            render: (_args, value) => [{ type: "text", text: value }],
          },
          // `sshTools` is a `SshTool<never>[]` so entries with different argument
          // objects share one list, and its elements expose no argument type to
          // recover; the registry has already validated the call against the very
          // descriptor spread above.
          execute: (args, execution) => tool.execute(args as never, execution),
        }),
      ),
    );
  }

  // Two teardown paths, and neither of them runs under `SIGKILL`: the disposer
  // that cordis awaits on unload, and a `process.on("exit")` hook for a shutdown
  // that got no further than `process.exit`. `ssh.ts` states what is left when
  // both are skipped.
  ctx.effect(() => {
    const onExit = (): void => pool.abort();
    process.on("exit", onExit);
    return () => {
      process.off("exit", onExit);
      return pool.dispose();
    };
  });
}
