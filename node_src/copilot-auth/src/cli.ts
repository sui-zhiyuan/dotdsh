#!/usr/bin/env node
/**
 * dotdsh-copilot-auth — the terminal half of the Copilot credential surface.
 *
 * It reports and removes a stored grant through dsh's own credential provider:
 * this process mounts `@deepseek-ai/dsh-credentials-local` in a throwaway Cordis
 * context and calls `readRecord` / `deleteRecord`, so the document format, the
 * 0600 mode and — decisively — the cross-process writer lock are dsh's own.
 * Editing the YAML directly would take none of those, and would race a running
 * dsh for the file.
 *
 * It no longer runs the sign-in. dsh owns the protocol now: the
 * `github-copilot` flow is registered by `@deepseek-ai/dsh-llm-pi-ai` into
 * `ctx.authorization`, and starting it needs that booted service graph — a CLI
 * process has no seam to call. `login` therefore prints how to run
 * `/copilot-login` inside dsh and exits non-zero.
 *
 * Usage:
 *   dotdsh-copilot-auth login  [--dsh-home <dir>]
 *   dotdsh-copilot-auth status [--dsh-home <dir>]
 *   dotdsh-copilot-auth logout [--dsh-home <dir>]
 *
 * Exit codes: 0 success, 1 failure or not signed in, 2 usage error.
 */
import { Context } from "@deepseek-ai/cordis";
import CredentialsLocal from "@deepseek-ai/dsh-credentials-local";
import { homedir } from "node:os";
import { join } from "node:path";
import { clearGrant, readStoredGrant } from "./record.js";
import { safeMessage } from "./redact.js";
import { grantSummaryLines } from "./summary.js";

const COMMANDS = ["login", "status", "logout"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = [
  "dotdsh-copilot-auth — GitHub Copilot credential helper for DeepSeek Harness",
  "",
  "Usage:",
  "  dotdsh-copilot-auth login  [--dsh-home <dir>]",
  "  dotdsh-copilot-auth status [--dsh-home <dir>]",
  "  dotdsh-copilot-auth logout [--dsh-home <dir>]",
  "",
  "  login   print how to run the sign-in inside dsh (/copilot-login); this",
  "          process cannot run it — the flow lives in dsh's authorization seam",
  "  status  report the stored record, its expiry and its model list",
  "  logout  remove the stored record (local only)",
  "",
  "  --dsh-home <dir>  the harness home to read and write",
  "                    (default: $DSH_HOME, else ~/.dsh)",
].join("\n");

interface Invocation {
  readonly command: Command;
  readonly dshHome: string;
}

function out(line: string): void {
  process.stdout.write(`${line}\n`);
}

function err(line: string): void {
  process.stderr.write(`${line}\n`);
}

/**
 * Parse the command line. A flag this program does not know is a usage error
 * rather than something to ignore: a mistyped `--dshhome` that silently wrote
 * to the default home is exactly the failure a user would not notice.
 */
function parse(argv: readonly string[]): Invocation | { readonly error: string } {
  let command: string | undefined;
  let dshHome = process.env["DSH_HOME"] ?? join(homedir(), ".dsh");
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dsh-home") {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${argument} needs a value` };
      index += 1;
      dshHome = value;
      continue;
    }
    if (argument === "--help" || argument === "-h") return { error: "" };
    if (argument !== undefined && argument.startsWith("-")) return { error: `unknown option ${argument}` };
    if (command !== undefined) return { error: `unexpected argument ${String(argument)}` };
    command = argument;
  }
  if (command === undefined) return { error: "no command given" };
  if (!COMMANDS.includes(command as Command)) return { error: `unknown command ${command}` };
  return { command: command as Command, dshHome };
}

/** Point a terminal user at the only surface that can start the flow. */
function reportLoginIsNotHere(): void {
  err("`dotdsh-copilot-auth login` no longer runs the sign-in: the GitHub Copilot flow lives in");
  err("dsh's authorization seam and needs a booted harness to start.");
  err("");
  err("Start dsh and run /copilot-login there. This command can still report and remove a");
  err("stored grant with `status` and `logout`.");
}

/** Report what is stored. Exit 1 when nothing usable is, so a script can branch on it. */
async function runStatus(ctx: Context): Promise<number> {
  const stored = await readStoredGrant(ctx.credentials);
  if (stored.rejected) {
    err("A GitHub Copilot record is stored but did not pass validation, so nothing is using it.");
    err("Run `dotdsh-copilot-auth logout`, then sign in again with /copilot-login inside dsh.");
    return 1;
  }
  if (stored.grant === undefined) {
    out("Not signed in to GitHub Copilot. Run /copilot-login inside dsh.");
    return 1;
  }
  out("Signed in to GitHub Copilot.");
  for (const line of grantSummaryLines(stored.grant)) out(`  ${line}`);
  return 0;
}

/** Forget the stored grant. */
async function runLogout(ctx: Context): Promise<number> {
  const removed = await clearGrant(ctx.credentials);
  out(
    removed
      ? "Signed out: the stored GitHub Copilot grant was removed. To revoke the authorization itself, use github.com/settings/apps."
      : "No GitHub Copilot grant was stored.",
  );
  return 0;
}

async function main(): Promise<number> {
  const parsed = parse(process.argv.slice(2));
  if ("error" in parsed) {
    if (parsed.error.length > 0) err(parsed.error);
    err("");
    err(USAGE);
    return 2;
  }
  if (parsed.command === "login") {
    reportLoginIsNotHere();
    return 1;
  }
  const ctx = new Context();
  try {
    await ctx.plugin(CredentialsLocal, { dshHome: parsed.dshHome, watch: false });
    switch (parsed.command) {
      case "status":
        return await runStatus(ctx);
      case "logout":
        return await runLogout(ctx);
    }
    return 2;
  } catch (error) {
    // A credential document this dsh cannot parse, or a home with no write
    // permission, lands here — the store's own message names the file.
    err(`copilot-auth: ${safeMessage(error)}`);
    return 1;
  } finally {
    await ctx.fiber.dispose();
  }
}

process.exitCode = await main();
