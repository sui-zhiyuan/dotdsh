// The host half's editor launcher: turn "(workspace root, workspace-relative or
// absolute file, optional line)" into a running `code --goto <file>:<line>`.
//
// Layer: the outermost host layer. It knows about processes and the filesystem
// and nothing about HTTP or about the browser; `open-in-vscode.ts` owns the
// route and `index.ts` owns the plugin wiring. This file must not import either.

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
  throw new Error("resolveEditorCommand is not implemented");
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
  throw new Error("launchInEditor is not implemented");
}
