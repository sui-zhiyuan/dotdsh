/**
 * The plugin's configuration, resolved: the eight settings every layer below the
 * boundary is handed as data.
 *
 * ## Where a setting comes from
 *
 * The row's `config` in the composition, and nothing else. It is resolved **once**,
 * when the plugin mounts — `index.ts` calls {@link resolveSettings} with what dsh
 * composed for the row — and everything below receives the result as a plain
 * object: `core` and this layer never read a configuration file, never consult a
 * service, and never import a harness package. That is the same rule the process
 * seam follows, and it is what lets the whole path be driven against a scratch
 * repository with no harness present.
 *
 * A setting a row omits takes its default. A setting a row gets wrong fails the
 * mount, loudly and by name, rather than at the first command that trips over it —
 * a `branchPrefix` that is not a legal ref, or a `worktreeRoot` that escapes the
 * repository, is a composition error and should read as one.
 *
 * ## Why the defaults are a value and not scattered literals
 *
 * {@link DEFAULT_FLOW_SETTINGS} is the one place the shipped values live. The
 * schema in `index.ts` takes each field's `.default` from it, {@link resolveSettings}
 * fills an omitted setting from it, the checks read it, and the two bundled skill
 * bodies are rendered from it. A default written twice is a default that can
 * disagree with itself.
 *
 * ## Layer
 *
 * The platform: the outside world. This module reads no file and starts no
 * process — it is data and the rules for it — and it imports nothing above it,
 * neither `core` nor the boundary. The dependency only ever points down.
 *
 * @module @dsh-external/dotdsh-git-flow/settings
 */

import { isAbsolute } from "node:path";

/**
 * Every setting this plugin has, resolved.
 *
 * Eight keys, each one a value a previous implementation let a deployment tune, or
 * a bound this rewrite would otherwise hardcode. They are read in three places and
 * nowhere else: the branch name a family gets (`branchPrefix`,
 * `branchSubjectMaxLength`, `integrationBranch`, `worktreeRoot`), the claim file's
 * own layout (`claimFile`, `lockStaleSeconds`), and the two policies
 * (`sweepAgeHours`, `guard`).
 */
export interface FlowSettings {
  /**
   * Prefix every feature branch carries, with its trailing slash: `feat/`.
   *
   * The subject a human or a model names is appended to it, and stripping it is how
   * a family's worktree directory name is derived, so this one value decides both
   * what a branch is called and where its tree goes.
   */
  readonly branchPrefix: string;
  /**
   * The branch a feature branch is cut from, and the branch a finished family is
   * merged into and put back on: `master`.
   */
  readonly integrationBranch: string;
  /**
   * Where a family's own worktree is created, relative to the repository's main
   * working tree: `.dsh.local/worktrees`.
   */
  readonly worktreeRoot: string;
  /**
   * The claim file, relative to the repository's main working tree:
   * `.dsh.local/git-flow.toml`.
   */
  readonly claimFile: string;
  /**
   * How old the claim file's lock has to be before another process may take it over.
   *
   * Ten seconds is four orders of magnitude above a critical section, which is a few
   * filesystem operations on a small file, and it is also how long a crashed holder
   * can keep the repository out of its own claim file.
   */
  readonly lockStaleSeconds: number;
  /**
   * How old a claim has to be before a sweep may collect it: 24 hours.
   *
   * The sweep's second gate. Unrecoverable is not enough on its own — a session
   * archived a minute ago may be one a human is about to reopen — so a claim is
   * only taken once nobody could still be coming back for it.
   */
  readonly sweepAgeHours: number;
  /**
   * The longest a feature branch's subject may be, after the prefix: 20.
   *
   * A policy rather than a syntax rule. It keeps a branch readable in
   * `git log --oneline --graph` and in the worktree's directory name, and short
   * enough that a model asked to name a feature names the feature.
   */
  readonly branchSubjectMaxLength: number;
  /**
   * Whether the pre-write guard runs: `on`.
   *
   * `off` is the escape hatch for a session that has to write somewhere the guard
   * would refuse — the guard is the plugin's only enforcement, and turning it off
   * turns the workflow advisory.
   */
  readonly guard: "on" | "off";
}

/**
 * The same eight settings, as a row may supply them.
 *
 * Every key optional: an omitted one takes its value from
 * {@link DEFAULT_FLOW_SETTINGS}, which is also what the row schema defaults to.
 */
export type FlowSettingsInput = Partial<FlowSettings>;

/** What every setting is when a row says nothing. */
export const DEFAULT_FLOW_SETTINGS: FlowSettings = {
  branchPrefix: "feat/",
  integrationBranch: "master",
  worktreeRoot: ".dsh.local/worktrees",
  claimFile: ".dsh.local/git-flow.toml",
  lockStaleSeconds: 10,
  sweepAgeHours: 24,
  branchSubjectMaxLength: 20,
  guard: "on",
};

/**
 * A branch name, or the prefix of one, that git will accept and this plugin can
 * hand to git as a single argument.
 *
 * Deliberately narrow. The first character is a letter, a digit or an underscore,
 * which is what keeps a value from being read as an option — a `branchPrefix` of
 * `--force` interpolated into a `git branch` call would be a flag, not a name — and
 * the rest is the character set git refs actually use.
 */
const REF_LIKE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

/** Characters git refuses in a ref name outright. */
const REF_FORBIDDEN = /[\s~^:?*[\\]/;

/** Sequences git refuses in a ref name, and the one a prefix must not end on. */
const REF_FORBIDDEN_SEQUENCE = /\.\.|@\{|\/\//;

/**
 * Turn what a row supplied into the settings every layer below reads.
 *
 * Fills each omitted key from {@link DEFAULT_FLOW_SETTINGS}, normalizes the two
 * values that have more than one spelling (`branchPrefix` gains the trailing slash
 * a row may have left off; `worktreeRoot` and `claimFile` lose trailing slashes),
 * and refuses anything the plugin could not honour.
 *
 * @param input - the row configuration, with only the keys the row set.
 * @returns the complete settings.
 * @throws Error naming the key and the value when one cannot be honoured.
 */
export function resolveSettings(input: FlowSettingsInput): FlowSettings {
  const settings: FlowSettings = {
    branchPrefix: `${stripTrailingSlashes(input.branchPrefix ?? DEFAULT_FLOW_SETTINGS.branchPrefix)}/`,
    integrationBranch: input.integrationBranch ?? DEFAULT_FLOW_SETTINGS.integrationBranch,
    worktreeRoot: stripTrailingSlashes(input.worktreeRoot ?? DEFAULT_FLOW_SETTINGS.worktreeRoot),
    claimFile: stripTrailingSlashes(input.claimFile ?? DEFAULT_FLOW_SETTINGS.claimFile),
    lockStaleSeconds: input.lockStaleSeconds ?? DEFAULT_FLOW_SETTINGS.lockStaleSeconds,
    sweepAgeHours: input.sweepAgeHours ?? DEFAULT_FLOW_SETTINGS.sweepAgeHours,
    branchSubjectMaxLength: input.branchSubjectMaxLength ?? DEFAULT_FLOW_SETTINGS.branchSubjectMaxLength,
    guard: input.guard ?? DEFAULT_FLOW_SETTINGS.guard,
  };

  checkRefLike(settings.branchPrefix.slice(0, -1), "branchPrefix", "a prefix a branch name can carry");
  checkRefLike(settings.integrationBranch, "integrationBranch", "a branch name");
  if (settings.integrationBranch.endsWith("/") || settings.integrationBranch.endsWith(".")) {
    throw refuse("integrationBranch", settings.integrationBranch, "a branch name cannot end with a slash or a dot");
  }
  checkRelativePath(settings.worktreeRoot, "worktreeRoot");
  checkRelativePath(settings.claimFile, "claimFile");
  checkWholeNumber(settings.lockStaleSeconds, "lockStaleSeconds", 1);
  checkPositiveNumber(settings.sweepAgeHours, "sweepAgeHours");
  checkWholeNumber(settings.branchSubjectMaxLength, "branchSubjectMaxLength", 1);
  if (settings.guard !== "on" && settings.guard !== "off") {
    throw refuse("guard", String(settings.guard), 'it has to be "on" or "off"');
  }

  return settings;
}

/**
 * Strip the trailing slashes a path setting may have been written with.
 *
 * `feat/`, `feat` and `feat//` are one prefix; the same goes for the two paths. A
 * value that is nothing but slashes comes back empty and is refused as such, which
 * is the honest reading of `worktreeRoot: "/"`.
 *
 * @param value - the raw value.
 * @returns the value without its trailing slashes.
 */
function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Refuse a value that is not usable as a ref name, or as a prefix of one.
 *
 * @param value - the value, with any trailing slash already removed.
 * @param key - the setting's name, for the message.
 * @param what - what the value is supposed to be, for the message.
 * @throws Error when git would refuse it, or could read it as an option.
 */
function checkRefLike(value: string, key: string, what: string): void {
  if (value === "") throw refuse(key, value, `it has to be ${what}`);
  if (!REF_LIKE.test(value)) {
    throw refuse(key, value, "it has to start with a letter, a digit or an underscore, and hold only letters, digits, dots, underscores, dashes and slashes");
  }
  if (REF_FORBIDDEN.test(value) || REF_FORBIDDEN_SEQUENCE.test(value)) {
    throw refuse(key, value, "git refuses a ref name with whitespace, `~^:?*[\\`, `..`, `//` or `@{` in it");
  }
  if (value.endsWith(".")) throw refuse(key, value, "a ref name cannot end with a dot");
}

/**
 * Refuse a path setting that is not inside the repository.
 *
 * Both paths are resolved against the repository's main working tree, and a path
 * that escapes it would put this plugin's own state somewhere the harness's file
 * tools and this plugin's guard do not reach.
 *
 * @param value - the raw value, without trailing slashes.
 * @param key - the setting's name, for the message.
 * @throws Error when the path is empty, absolute, or walks upwards.
 */
function checkRelativePath(value: string, key: string): void {
  if (value === "") throw refuse(key, value, "it has to name a path inside the repository");
  if (isAbsolute(value)) throw refuse(key, value, "it has to be a path inside the repository, not an absolute one");
  if (value.split("/").includes("..")) throw refuse(key, value, "it has to stay inside the repository");
}

/**
 * Refuse a number that is not a whole number at or above a floor.
 *
 * @param value - the raw value.
 * @param key - the setting's name, for the message.
 * @param floor - the smallest value that can work.
 * @throws Error when the value is below the floor or not a whole number.
 */
function checkWholeNumber(value: number, key: string, floor: number): void {
  if (!Number.isInteger(value) || value < floor) {
    throw refuse(key, String(value), `it has to be a whole number of at least ${floor}`);
  }
}

/**
 * Refuse a number of hours that is not a positive, finite measurement.
 *
 * @param value - the raw value.
 * @param key - the setting's name, for the message.
 * @throws Error when the value cannot measure a duration.
 */
function checkPositiveNumber(value: number, key: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw refuse(key, String(value), "it has to be a duration longer than zero");
  }
}

/**
 * Build the one error shape every refusal uses.
 *
 * The text is read by whoever wrote the composition row, at mount time, so it names
 * the plugin, the key, the value and the reason in that order.
 *
 * @param key - the setting's name.
 * @param value - the value that was refused.
 * @param reason - why it cannot be honoured.
 * @returns the error to throw.
 */
function refuse(key: string, value: string, reason: string): Error {
  return new Error(`git-flow: ${key} ${JSON.stringify(value)} cannot be used: ${reason}`);
}
