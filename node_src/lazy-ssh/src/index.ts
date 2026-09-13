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
import z from "@deepseek-ai/schemastery";
import type { SshConfig } from "./platform/ssh.js";

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
  throw new Error(`resolveSshConfig is not implemented: ${config.controlDir}`);
}

/**
 * Register this plugin's contributions.
 *
 * @param ctx - the plugin context, with `tools` injected.
 * @param config - the row's configuration, validated by {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  throw new Error("lazy-ssh apply is not implemented");
}
