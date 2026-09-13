#!/usr/bin/env node
/**
 * dotdsh-copilot-auth — the terminal half of the same sign-in.
 *
 * It exists because dsh's web surface has no OAuth entry point: the Models page
 * edits API keys, and the harness authorization seam has no client that calls
 * it. The `/copilot-login` command covers a user sitting in the GUI; this CLI
 * covers the other two cases — a machine whose dsh is not running yet, and a
 * user who would rather not put a device-code login behind a web request.
 *
 * Both paths write the *same* record through the *same* service: this process
 * mounts dsh's own credential provider (`@deepseek-ai/dsh-credentials-local`)
 * in a throwaway Cordis context and calls `modifyRecord`, so the document
 * format, the 0600 mode, the atomic replace and — decisively — the
 * cross-process writer lock are dsh's own. Editing the YAML directly would
 * take none of those, and would race a running dsh for the file.
 *
 * Usage:
 *   dotdsh-copilot-auth login  [--dsh-home <dir>] [--timeout <ms>]
 *   dotdsh-copilot-auth status [--dsh-home <dir>]
 *   dotdsh-copilot-auth logout [--dsh-home <dir>]
 *
 * Exit codes: 0 success, 1 failure or not signed in, 2 usage error.
 */
import { Context } from "@deepseek-ai/cordis";
import CredentialsLocal from "@deepseek-ai/dsh-credentials-local";
import { homedir } from "node:os";
import { join } from "node:path";
import { loginCopilot } from "./login.js";
import { clearGrant, readStoredGrant, storeGrant } from "./record.js";
import { safeMessage } from "./redact.js";
import { grantSummaryLines } from "./summary.js";

const COMMANDS = ["login", "status", "logout"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = [
  "dotdsh-copilot-auth — GitHub Copilot sign-in for DeepSeek Harness",
  "",
  "Usage:",
  "  dotdsh-copilot-auth login  [--dsh-home <dir>] [--timeout <ms>]",
  "  dotdsh-copilot-auth status [--dsh-home <dir>]",
  "  dotdsh-copilot-auth logout [--dsh-home <dir>]",
  "",
  "  login   run the device-code flow and store the grant the stock",
  "          github-copilot route reads (default timeout: 180000 ms)",
  "  status  report the stored grant, its expiry and its model list",
  "  logout  remove the stored grant (local only)",
  "",
  "  --dsh-home <dir>  the harness home to read and write",
  "                    (default: $DSH_HOME, else ~/.dsh)",
].join("\n");

interface Invocation {
  readonly command: Command;
  readonly dshHome: string;
  readonly timeoutMs: number;
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
  let timeoutMs = 180_000;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dsh-home" || argument === "--timeout") {
      const value = argv[index + 1];
      if (value === undefined) return { error: `${argument} needs a value` };
      index += 1;
      if (argument === "--dsh-home") dshHome = value;
      else {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) return { error: "--timeout must be a positive integer of milliseconds" };
        timeoutMs = parsed;
      }
      continue;
    }
    if (argument === "--help" || argument === "-h") return { error: "" };
    if (argument !== undefined && argument.startsWith("-")) return { error: `unknown option ${argument}` };
    if (command !== undefined) return { error: `unexpected argument ${String(argument)}` };
    command = argument;
  }
  if (command === undefined) return { error: "no command given" };
  if (!COMMANDS.includes(command as Command)) return { error: `unknown command ${command}` };
  return { command: command as Command, dshHome, timeoutMs };
}

/** Run the device-code sign-in and store its grant. */
async function runLogin(ctx: Context, invocation: Invocation): Promise<number> {
  const stored = await readStoredGrant(ctx.credentials);
  if (stored.grant !== undefined) {
    err("Already signed in. Run `dotdsh-copilot-auth logout` first to replace the stored grant.");
    return 1;
  }
  const controller = new AbortController();
  const interrupt = (): void => {
    controller.abort();
  };
  process.once("SIGINT", interrupt);
  const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(invocation.timeoutMs)]);
  try {
    const grant = await loginCopilot({
      signal: deadline,
      onNotice: (notice) => {
        if (notice.kind === "device-code") {
          err("");
          err(`  Open: ${notice.verificationUri}`);
          err(`  Code: ${notice.userCode}`);
          if (notice.expiresInSeconds !== undefined) {
            err(`  (valid for about ${Math.round(notice.expiresInSeconds / 60)} minutes)`);
          }
          err("  Waiting for authorization...");
          return;
        }
        err(`  ${notice.message}${notice.kind === "info" && notice.url !== undefined ? ` (${notice.url})` : ""}`);
      },
    });
    await storeGrant(ctx.credentials, grant);
    out("Signed in to GitHub Copilot. The grant is stored in the harness credential document (0600).");
    for (const line of grantSummaryLines(grant)) out(`  ${line}`);
    out("");
    out("Nothing serves the models until the provider route is declared in $DSH_HOME/settings.yaml");
    out("(or on the Models page). It takes effect on the next request — no restart:");
    out("  llm-pi-ai:");
    out("    providers:");
    out("      github-copilot: {}");
    return 0;
  } catch (error) {
    err(`Sign-in failed: ${safeMessage(error)}`);
    return 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
  }
}

/** Report what is stored. Exit 1 when nothing usable is, so a script can branch on it. */
async function runStatus(ctx: Context): Promise<number> {
  const stored = await readStoredGrant(ctx.credentials);
  if (stored.rejected) {
    err("A GitHub Copilot record is stored but did not pass validation, so nothing is using it.");
    err("Run `dotdsh-copilot-auth logout`, then `dotdsh-copilot-auth login`.");
    return 1;
  }
  if (stored.grant === undefined) {
    out("Not signed in to GitHub Copilot. Run `dotdsh-copilot-auth login`.");
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
  const ctx = new Context();
  try {
    await ctx.plugin(CredentialsLocal, { dshHome: parsed.dshHome, watch: false });
    switch (parsed.command) {
      case "login":
        return await runLogin(ctx, parsed);
      case "status":
        return await runStatus(ctx);
      case "logout":
        return await runLogout(ctx);
    }
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
