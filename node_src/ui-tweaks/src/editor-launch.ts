// The host half's editor launcher: turn "(workspace root, workspace-relative or
// absolute file, optional line)" into a running `code --goto <file>:<line>`.
//
// Layer: the outermost host layer. It knows about processes and the filesystem
// and nothing about HTTP or about the browser; `open-in-vscode.ts` owns the
// route and `index.ts` owns the plugin wiring. This file must not import either.

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { delimiter, extname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Config } from "./settings.js";

/**
 * The part of `AbortSignal` this module uses, named locally because at runtime
 * this package serves BOTH a Node host half and a browser half: pulling the DOM
 * lib into its one compile would silently bless browser globals inside host code.
 * The structural type keeps a real `AbortSignal` assignable while promising the
 * host half nothing it does not need.
 */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
}

/**
 * Whether a signal is already aborted, read through a call.
 *
 * A direct `signal.aborted` test narrows the property for the whole rest of the
 * function, and that narrowing survives the `await`s in between: every later
 * check would compare against a `false` the compiler still believes in, which is
 * exactly the "no overlap" dead-branch diagnostic while the signal can in fact
 * abort while a `stat` or a lookup is in flight. The call boundary keeps each
 * check a fresh read.
 */
function isAborted(signal: AbortSignalLike | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Configuration an {@link launchInEditor} call needs, so that the launcher does
 * not read the ui-tweaks settings service itself: the route layer resolves the
 * settings once per request and passes what it read.
 */
export interface EditorLaunchConfig extends Pick<Config, "openInVscode" | "editorCommand"> {}

/**
 * Absolute canonical executable path of the editor command, or `undefined` when
 * the command does not resolve in this execution world.
 *
 * This is the availability probe the browser asks for: it is deliberately
 * separate from {@link launchInEditor} so that a page can learn *once* whether a
 * Ctrl/Cmd+click is interceptable, and thereby decide synchronously (inside the
 * click, not after a round trip) whether to claim the event.
 *
 * @param command - the configured editor command: one bare name resolved on
 *   PATH (`code`) or one absolute executable path. Arguments are not accepted —
 *   `argv` is this package's business, and a command with a space in it would
 *   be a silently truncated path, not a command with arguments.
 * @param signal - aborts the lookup.
 * @returns the resolved absolute path, or `undefined` when nothing resolves.
 */
export async function resolveEditorCommand(
  command: string,
  signal?: AbortSignalLike,
): Promise<string | undefined> {
  if (isAborted(signal)) return undefined;
  // A command is one token. Whitespace means either arguments (which this
  // package owns) or a truncated path; neither is spawnable, and the probe has
  // exactly one negative answer, so both report as "does not resolve".
  if (command === "" || /\s/.test(command)) return undefined;
  if (isAbsolute(command)) {
    const absolute = resolve(command);
    return (await isFile(absolute)) ? absolute : undefined;
  }
  // A separator makes it a relative path, not a bare PATH name. Its resolution
  // base is undefined, so it must not be guessed against this process's cwd.
  if (command.includes("/") || command.includes("\\")) return undefined;
  return await resolveOnPath(command, signal);
}

/**
 * Why a launch did not happen. Every member is something a caller can act on:
 * the page falls back to dsh's own preview only for the failures that mean "this
 * machine cannot do it", and stays silent for the ones that mean "this click was
 * not ours".
 */
export type EditorLaunchFailure =
  /** `openInVscode` is off for this machine; the page must fall back. */
  | "disabled"
  /** The configured command does not resolve on this host. */
  | "not-installed"
  /** The file does not exist, is a directory, or cannot be examined. */
  | "unresolvable"
  /** The target is a real file but not inside the session's workspace root. */
  | "outside-workspace"
  /** The launcher was spawned but failed before it could hand off (non-zero exit). */
  | "launch-failed";

/** Outcome of one {@link launchInEditor} call. */
export type EditorLaunchResult =
  | { readonly ok: true; /** The canonical path of the file handed to the editor. */ readonly file: string }
  | { readonly ok: false; readonly reason: EditorLaunchFailure; /** One line, for the page's console and for `verify` runs. */ readonly detail: string };

/**
 * Open one file at one line in the configured editor.
 *
 * Contract:
 * - `path` is authoritative: absolute, or relative to `workspaceRoot`, and
 *   resolved against it with the platform's own separator rules. A relative
 *   path with no `workspaceRoot` is `unresolvable`, never a guess against the
 *   host process's own cwd.
 * - The resolve-then-contain order is load-bearing: the target is resolved
 *   FIRST and the result is checked against `workspaceRoot` (with symlinks
 *   followed), so `../` cannot walk out and a symlink inside the workspace
 *   cannot point out of it.
 * - `line` is optional and 1-based. When present it becomes
 *   `--goto <file>:<line>`; when absent the file is passed bare. A line that is
 *   not a positive integer is ignored rather than rejected (the file still
 *   opens), because the line is a convenience the surfaces add, not a
 *   precondition.
 * - The child is spawned detached with its stdio ignored and its result is not
 *   awaited: `code` is a launcher that may return immediately (and on WSL the
 *   wrapper hands off to a Windows process), so a short-lived parent must not be
 *   able to kill it. Only a synchronous spawn failure, or an early non-zero exit
 *   within a small watch window, is reported; a process still running at the end
 *   of that window counts as launched.
 * - `openInVscode === false` returns `disabled` WITHOUT touching the filesystem,
 *   so a user who turned the switch off does not pay a `stat` per click.
 *
 * @param workspaceRoot - the session's absolute workspace root, when known.
 * @param path - absolute path, or a path relative to `workspaceRoot`.
 * @param line - optional 1-based line to place the cursor on.
 * @param config - the resolved ui-tweaks settings for this request.
 * @param signal - aborts the lookup/spawn.
 * @returns whether the file was handed to the editor.
 */
export async function launchInEditor(
  workspaceRoot: string | undefined,
  path: string,
  line: number | undefined,
  config: EditorLaunchConfig,
  signal?: AbortSignalLike,
): Promise<EditorLaunchResult> {
  // Off means off: return before the first filesystem call, so a machine with
  // the tweak disabled pays nothing for a click it will not intercept.
  if (!config.openInVscode) {
    return { ok: false, reason: "disabled", detail: "ui-tweaks: openInVscode is off for this machine" };
  }
  if (isAborted(signal)) {
    return { ok: false, reason: "launch-failed", detail: "ui-tweaks: aborted before the editor was spawned" };
  }

  // `path` is authoritative: an absolute one is used as written, a relative one
  // is resolved against the session's root — never against this process's cwd,
  // which would be a different directory in a different execution world.
  let target: string;
  if (isAbsolute(path)) {
    target = path;
  } else if (workspaceRoot === undefined) {
    return { ok: false, reason: "unresolvable", detail: `ui-tweaks: "${path}" is relative and this session has no workspace root` };
  } else {
    target = resolve(workspaceRoot, path);
  }

  // Symlinks are followed BEFORE containment, and `../` is collapsed by the
  // resolution above: that is what makes the check meaningful rather than a
  // string prefix test a link or a `..` can walk around. A target that cannot
  // be canonicalized is one that does not exist.
  let file: string;
  try {
    file = await realpath(target);
  } catch {
    return { ok: false, reason: "unresolvable", detail: `ui-tweaks: "${target}" does not exist` };
  }

  if (workspaceRoot !== undefined) {
    const root = await canonicalRootOf(workspaceRoot);
    if (!isInside(root, file)) {
      return { ok: false, reason: "outside-workspace", detail: `ui-tweaks: "${file}" is outside the workspace root` };
    }
  }

  // Only a regular file has a line to open: a directory (or a socket, device,
  // or a path that vanished between realpath and here) is not a click target.
  if (!(await isFile(file))) {
    return { ok: false, reason: "unresolvable", detail: `ui-tweaks: "${file}" is not a regular file` };
  }

  const executable = await resolveEditorCommand(config.editorCommand, signal);
  if (executable === undefined) {
    return { ok: false, reason: "not-installed", detail: `ui-tweaks: editor command "${config.editorCommand}" does not resolve on this host` };
  }
  if (isAborted(signal)) {
    return { ok: false, reason: "launch-failed", detail: "ui-tweaks: aborted before the editor was spawned" };
  }

  // A line the surface got wrong is a convenience missed, not a click refused:
  // a non-positive or non-integer line is dropped and the file opens bare.
  const gotoLine = line !== undefined && Number.isInteger(line) && line > 0 ? line : undefined;
  return await spawnEditor(executable, file, gotoLine, signal);
}

/**
 * How long a spawned editor may run before the launch is counted as done. Long
 * enough for a launcher that fails immediately to say so — the WSL `code`
 * wrapper hands off to a Windows process and can fail fast — and short enough
 * that a click never waits on the editor's own lifetime, which belongs to the
 * child. A child still running when the window closes is unrefed and counted.
 */
const EARLY_FAILURE_WATCH_MS = 2000;

/**
 * Spawn the editor detached and watch only its first moments.
 *
 * `spawn` is used without a shell and with argv as a list, so a path with a
 * space in it is one argument rather than something a shell can reinterpret.
 * The child is unrefed the moment it exists: it must outlive a short-lived
 * parent and must not be held open (or signalled) by that parent's exit.
 */
async function spawnEditor(
  executable: string,
  file: string,
  line: number | undefined,
  signal: AbortSignalLike | undefined,
): Promise<EditorLaunchResult> {
  // argv is built whole so the command line stays one value; `spawn` takes
  // argv[0] separately because it never searches a shell for the program.
  const argv = line === undefined ? [executable, file] : [executable, "--goto", `${file}:${line}`];

  return await new Promise<EditorLaunchResult>((settle) => {
    let settled = false;
    let watch: ReturnType<typeof setTimeout> | undefined;

    function finish(result: EditorLaunchResult): void {
      if (settled) return;
      settled = true;
      if (watch !== undefined) clearTimeout(watch);
      signal?.removeEventListener("abort", onAbort);
      settle(result);
    }
    function onAbort(): void {
      // Aborting ends the WATCH, not the editor: the child is already spawned
      // and keeps running, which is exactly what the window's expiry means. An
      // abort before the spawn is handled by the caller, which never gets here.
      finish({ ok: true, file });
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore", windowsHide: false });
    } catch (error) {
      // `spawn` throws synchronously only for a malformed request; a program
      // that is not there reports through the `error` event below, so both
      // paths are needed to catch "the editor never started".
      finish({ ok: false, reason: "launch-failed", detail: `ui-tweaks: ${messageOf(error)}` });
      return;
    }
    child.unref();

    // Both listeners are attached before the watch starts: a child that never
    // starts emits `error`, one that starts and dies emits `exit`.
    child.on("error", (error) => {
      finish({ ok: false, reason: "launch-failed", detail: `ui-tweaks: ${error.message}` });
    });
    child.on("exit", (code, exitSignal) => {
      if (code === 0) {
        finish({ ok: true, file });
        return;
      }
      // stdio is ignored, so there is no stderr to quote; the exit facts are the
      // only diagnosis this launcher can offer.
      finish({
        ok: false,
        reason: "launch-failed",
        detail: `ui-tweaks: "${executable}" exited with code ${code}, signal ${exitSignal}`,
      });
    });

    if (signal !== undefined) {
      if (isAborted(signal)) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    // The timer is the promise's only exit for a child that never says
    // anything: it fires regardless of the child's state, so an immature
    // process can never leave this promise pending.
    watch = setTimeout(() => finish({ ok: true, file }), EARLY_FAILURE_WATCH_MS);
  });
}

/** Whether one path names an existing regular file; anything unreadable is not. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    // ENOENT, EACCES and ENOTDIR all mean the same thing to a probe: no file.
    return false;
  }
}

/**
 * Resolve one bare name on the host's own PATH.
 *
 * This leaf layer reads PATH directly instead of importing a subprocess
 * service: the launcher owns its own executable lookup, and the candidate scan
 * mirrors the harness's local provider (first PATH hit wins, PATHEXT on
 * Windows, an explicit extension tried as written) so a bare `code` resolves
 * the same way here as it would there.
 */
async function resolveOnPath(name: string, signal?: AbortSignalLike): Promise<string | undefined> {
  const path = process.env["PATH"] ?? "";
  const extensions =
    process.platform === "win32" && extname(name) === ""
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];
  for (const directory of path.split(delimiter)) {
    if (directory === "") continue;
    for (const extension of extensions) {
      // PATH order is precedence order, so the first hit wins; an abort stops
      // before the next probe rather than leaving the caller waiting on it.
      if (isAborted(signal)) return undefined;
      const candidate = resolve(directory, `${name}${extension}`);
      if (await isFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * The workspace root with symlinks followed. A root that itself cannot be
 * canonicalized falls back to its lexical absolute form, so a `../` escape is
 * still refused even though the root could not be verified.
 */
async function canonicalRootOf(workspaceRoot: string): Promise<string> {
  try {
    return await realpath(workspaceRoot);
  } catch {
    return resolve(workspaceRoot);
  }
}

/** Whether `target` is `root` itself or lives under it, by path segment. */
function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  // `rel` starts with `..` only for an escape; the `..` name itself is a
  // sibling directory and must not be mistaken for one (plain `startsWith`
  // would also reject the legitimate `..foo` entry).
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** One line for a thrown value, for the result detail a console logs. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
