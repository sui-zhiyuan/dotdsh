import type { CommandDefinition, CommandInvocation, CommandResult } from "@deepseek-ai/dsh-commands";
import { clearGrant, readStoredGrant, type CredentialRecords } from "./record.js";
import { safeMessage } from "./redact.js";
import type { CopilotSignInRequest, LoginNotice } from "./seam.js";
import { grantSummaryLines } from "./summary.js";

/** The one command a human runs to sign in. */
const LOGIN = "copilot-login";
/** The command that reports what is stored. */
const STATUS = "copilot-status";
/** The command that forgets the stored sign-in. */
const LOGOUT = "copilot-logout";

/** The three command names this package registers, in the order a human meets them. */
export const COPILOT_COMMAND_NAMES = [LOGIN, STATUS, LOGOUT] as const;

/**
 * How long the sign-in has to produce its device code before the attempt is
 * called off. The flow's first act is one HTTPS POST to GitHub, so this is a
 * network-failure window, not a human-speed one: the code is on screen in about
 * a second on a working connection.
 */
const NOTICE_WINDOW_MS = 20_000;

/** How long a second `/copilot-login` waits for an attempt that may already have settled. */
const REJOIN_WINDOW_MS = 2_000;

/** The registry shape this module needs; `ctx.commands` satisfies it. */
export interface CommandRegistry {
  register(definition: CommandDefinition): () => void;
}

/** What the commands need from their host. */
export interface CopilotCommandOptions {
  /** The harness credential store. */
  readonly credentials: CredentialRecords;
  /**
   * The seam runner, injectable so the committed checks drive every branch.
   * It resolves once dsh's authorization flow has committed the record; this
   * package never writes it.
   */
  readonly login: (request: CopilotSignInRequest) => Promise<void>;
  /** How long one attempt may take before it aborts itself. */
  readonly loginWindowMs: number;
  /**
   * Whether the stock `llm-pi-ai` adapter currently registers the copilot
   * route. Absent when this composition has no LLM service to ask, in which
   * case the status output simply omits the line.
   */
  readonly routeConfigured?: () => boolean;
  /**
   * Whether dsh currently registers an authorization flow for this record —
   * `authorization.describe(key) !== undefined`. Absent when this composition
   * has no authorization service to ask, in which case the status output omits
   * the line rather than claiming the flow is missing.
   */
  readonly flowRegistered?: () => boolean;
  /** Where a background failure goes — the attempt's own result has no surface. */
  readonly warn?: (message: string, error: unknown) => void;
}

/** The one notice the login command waits for: everything else is progress. */
type DeviceCodeNotice = Extract<LoginNotice, { kind: "device-code" }>;

/** One in-flight sign-in: the human needs its code, and a second call may join it. */
interface Attempt {
  readonly controller: AbortController;
  /** Resolves with the first device code, or with undefined once the flow settles without one. */
  readonly notice: Promise<DeviceCodeNotice | undefined>;
  /** Settles when the flow does; resolving means the record is committed. */
  readonly settled: Promise<void>;
}

/** The provider-profile snippet a signed-in user still has to add, when nothing serves the route. */
const ROUTE_HINT = [
  "  llm-pi-ai:",
  "    providers:",
  "      github-copilot: {}",
];

/**
 * Register the human-facing Copilot commands.
 *
 * These are slash commands, not tools, and that is the whole security design:
 * a command is typed by a human and executed without the model, so no prompt
 * injection reaching any model can start a device-code authorization, read a
 * record, or drop one. Nothing this package registers is model-callable.
 *
 * `/copilot-login` returns as soon as the flow has a device code to show —
 * that code *is* the answer, and there is no channel for a later message to
 * reach the same human, so the attempt continues in the background and the
 * confirmation is a second call: run `/copilot-login` again, or
 * `/copilot-status`. A second call never starts a second attempt; it reports on
 * the one already running. The record is written by dsh's flow, never here: on
 * success the store is re-read, and a freshly committed record that fails this
 * package's validation is reported rather than silently accepted.
 *
 * @param registry - the command registry to register into.
 * @param options - the store, the seam runner, and the reporting knobs.
 * @returns a disposer that unregisters the commands and aborts any attempt still running.
 */
export function registerCopilotCommands(registry: CommandRegistry, options: CopilotCommandOptions): () => void {
  let attempt: Attempt | undefined;
  const disposers: (() => void)[] = [];

  /** Start one attempt. Notices other than the device code are dropped: nothing reads them yet. */
  const start = (): Attempt => {
    const controller = new AbortController();
    const deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(options.loginWindowMs)]);
    let announceNotice: (notice: DeviceCodeNotice | undefined) => void = () => undefined;
    const notice = new Promise<DeviceCodeNotice | undefined>((resolve) => {
      announceNotice = resolve;
    });
    const settled = options.login({
      signal: deadline,
      onNotice: (event) => {
        if (event.kind === "device-code") announceNotice(event);
      },
    });
    settled.then(
      () => announceNotice(undefined),
      () => announceNotice(undefined),
    );
    return { controller, notice, settled };
  };

  /** The lines that tell a signed-in user how to make the route actually serve them. */
  const routeLines = (): string[] => {
    const configured = options.routeConfigured;
    if (configured === undefined) return [];
    if (configured()) return ["Provider route: the `github-copilot` route is registered."];
    return [
      "Provider route: NOT registered, so nothing is serving these models yet. Add this to $DSH_HOME/settings.yaml",
      "(or add the provider on the Models page); it takes effect on the next request:",
      ...ROUTE_HINT,
    ];
  };

  /**
   * The line that says whether `/copilot-login` can run at all. dsh registers
   * the flow for every catalog provider when `llm-pi-ai` mounts, but a
   * composition can omit that row, and then `begin()` answers `NO_FLOW`; saying
   * so on the status command is cheaper than making the human discover it by
   * running the login.
   */
  const flowLines = (): string[] => {
    const registered = options.flowRegistered;
    if (registered === undefined) return [];
    if (registered()) {
      return ["Authorization flow: dsh registers one for llm-pi-ai/github-copilot, so /copilot-login can run it."];
    }
    return ["Authorization flow: NOT registered, so /copilot-login cannot run; is the llm-pi-ai row mounted?"];
  };

  /**
   * Report a sign-in that just finished, from the record dsh's flow committed.
   *
   * The write is the flow's, so this re-reads the store instead of receiving the
   * grant. A record that fails validation is named explicitly: it is the one
   * case where the flow reported success and this package still refuses to use
   * what was written, and hiding it behind a bare "signed in" would leave the
   * user with a record nothing authenticates against.
   */
  const signedInLines = async (): Promise<string[]> => {
    const stored = await readStoredGrant(options.credentials);
    if (stored.rejected) {
      return [
        "The sign-in finished, but the record dsh wrote did not pass validation, so nothing is using it.",
        "Run /copilot-logout and then /copilot-login to replace it.",
      ];
    }
    if (stored.grant === undefined) {
      return ["The sign-in finished, but no GitHub Copilot record is stored; dsh's flow did not commit one."];
    }
    return ["Signed in to GitHub Copilot.", ...grantSummaryLines(stored.grant)];
  };

  /** Report on an attempt that is already in flight, without starting another. */
  const rejoin = async (current: Attempt): Promise<CommandResult> => {
    const outcome = await Promise.race([
      current.settled.then(
        () => "done" as const,
        () => "failed" as const,
      ),
      new Promise<"waiting">((resolve) => {
        setTimeout(() => resolve("waiting"), REJOIN_WINDOW_MS);
      }),
    ]);
    if (outcome === "waiting") {
      return {
        kind: "success",
        text: "A GitHub Copilot sign-in is already in progress. Finish it in the browser, then run /copilot-status.",
      };
    }
    if (outcome === "failed") {
      try {
        await current.settled;
      } catch (error) {
        return { kind: "error", text: `GitHub Copilot sign-in failed: ${safeMessage(error)}` };
      }
    }
    await current.settled;
    return { kind: "success", text: (await signedInLines()).join("\n") };
  };

  const login: CommandDefinition = {
    name: LOGIN,
    description: "Start dsh's GitHub Copilot authorization flow, show its device code, and let the flow store the record",
    handler: async (invocation: CommandInvocation): Promise<CommandResult> => {
      if (invocation.rawInput.trim().length > 0) {
        return { kind: "error", text: "Usage: /copilot-login (no arguments)" };
      }
      const stored = await readStoredGrant(options.credentials);
      if (stored.grant !== undefined) {
        return {
          kind: "error",
          text: "GitHub Copilot is already signed in. Run /copilot-logout first to replace the stored grant.",
        };
      }
      if (attempt !== undefined) return await rejoin(attempt);

      const current = start();
      attempt = current;
      current.settled.then(
        () => undefined,
        (error: unknown) => {
          options.warn?.("copilot-auth: the sign-in attempt did not finish", error);
        },
      ).finally(() => {
        if (attempt === current) attempt = undefined;
      });

      const first = await Promise.race([
        current.notice,
        new Promise<"timeout">((resolve) => {
          setTimeout(() => resolve("timeout"), NOTICE_WINDOW_MS);
        }),
      ]);
      if (first === undefined) {
        // The flow settled before it reported a device code. `settled`
        // resolving means it committed the record, so this is a completed
        // sign-in, not a silent failure: report what was written.
        try {
          await current.settled;
        } catch (error) {
          return { kind: "error", text: `GitHub Copilot sign-in failed: ${safeMessage(error)}` };
        }
        return { kind: "success", text: (await signedInLines()).join("\n") };
      }
      if (first === "timeout") {
        current.controller.abort();
        return {
          kind: "error",
          text: `The sign-in produced no device code within ${Math.round(NOTICE_WINDOW_MS / 1000)}s and was called off. Check this machine's network access to GitHub and try again.`,
        };
      }
      const minutes = first.expiresInSeconds === undefined ? undefined : Math.round(first.expiresInSeconds / 60);
      return {
        kind: "success",
        text: [
          "Open this page and enter the code to authorize GitHub Copilot:",
          `  ${first.verificationUri}`,
          `  code: ${first.userCode}`,
          ...(minutes === undefined ? [] : [`The code is valid for about ${minutes} minutes.`]),
          "When the browser says it is done, run /copilot-status to confirm the record was stored.",
        ].join("\n"),
      };
    },
  };

  const status: CommandDefinition = {
    name: STATUS,
    description: "Report the stored GitHub Copilot sign-in, its expiry, and whether the route and the authorization flow are registered",
    handler: async (): Promise<CommandResult> => {
      if (attempt !== undefined) {
        return await rejoin(attempt);
      }
      const stored = await readStoredGrant(options.credentials);
      if (stored.rejected) {
        return {
          kind: "error",
          text: [
            "A GitHub Copilot record is stored but did not pass validation, so nothing is using it.",
            "Run /copilot-logout and then /copilot-login to replace it.",
          ].join("\n"),
        };
      }
      if (stored.grant === undefined) {
        return {
          kind: "success",
          text: ["GitHub Copilot is not signed in. Run /copilot-login.", ...routeLines(), ...flowLines()].join("\n"),
        };
      }
      return {
        kind: "success",
        text: ["GitHub Copilot is signed in.", ...grantSummaryLines(stored.grant), ...routeLines(), ...flowLines()].join("\n"),
      };
    },
  };

  const logout: CommandDefinition = {
    name: LOGOUT,
    description: "Remove the stored GitHub Copilot grant (local only; revoke the GitHub authorization separately)",
    handler: async (): Promise<CommandResult> => {
      const removed = await clearGrant(options.credentials);
      return {
        kind: "success",
        text: removed
          ? "Signed out: the stored GitHub Copilot grant was removed. To revoke the authorization itself, use github.com/settings/apps."
          : "No GitHub Copilot grant was stored.",
      };
    },
  };

  for (const definition of [login, status, logout]) disposers.push(registry.register(definition));
  return () => {
    for (const dispose of disposers.splice(0)) dispose();
    attempt?.controller.abort();
    attempt = undefined;
  };
}
