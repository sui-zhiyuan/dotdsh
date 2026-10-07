// The seam half of this package: start dsh's own GitHub Copilot authorization
// flow and translate the conversation with the human into this package's
// notice vocabulary.
//
// dsh 0.2.0-rc.2 ships the protocol and the write, not the caller. Placed in
// context by `@deepseek-ai/dsh-llm-pi-ai`, `ctx.authorization` holds one flow
// per catalog provider — the `github-copilot` one is keyed by the credential
// record `llm-pi-ai/github-copilot` and runs pi-ai's device-code login, token
// exchange and model-list read, committing the record through
// `ctx.credentials` before its `run()` resolves. What no shipped surface does is
// call `ctx.authorization.begin(...)`: the Web Models page edits API keys, and
// the seam's own documentation says a caller starting an authorization is the
// one that can talk to the human. This module is that caller.
//
// It owns no protocol and writes no record: it supplies an
// {@link AuthorizationInteraction} (notices out, prompts in), maps the seam's
// failure codes to text a human can act on, and lets the flow keep its half of
// the contract.
//
// Layer: between the command surface (`commands.ts`) and the harness seam. It
// imports the seam's types and values and `constants.ts`, and nothing else in
// this package except the record key.

import {
  AuthorizationDeclinedError,
  AuthorizationError,
  type AuthorizationInteraction,
  type AuthorizationNotice,
  type AuthorizationOutcome,
  type AuthorizationPrompt,
  type AuthorizationService,
} from "@deepseek-ai/dsh-authorization";
import { COPILOT_RECORD_KEY } from "./constants.js";

/**
 * One thing the sign-in flow wants the human to see while it runs.
 *
 * The device-code step is the only one carrying two facts at once — where to go
 * and what to type there — which is why it keeps its `code` beside its URL
 * instead of folding both into a sentence. This is the shape the command
 * surface already renders, kept here because the protocol that produced it
 * (`login.ts`) no longer exists in this package.
 */
export type LoginNotice =
  | {
      readonly kind: "device-code";
      readonly userCode: string;
      readonly verificationUri: string;
      /** Seconds the code stays valid, when the issuer said. */
      readonly expiresInSeconds?: number;
    }
  | { readonly kind: "progress"; readonly message: string }
  | { readonly kind: "info"; readonly message: string; readonly url?: string };

/** One sign-in attempt's inputs, as the command surface hands them to the runner. */
export interface CopilotSignInRequest {
  /** Aborts the whole attempt: the outstanding prompt and the flow's own polling. */
  readonly signal: AbortSignal;
  /** Called as the flow reports progress. Must not throw. */
  readonly onNotice: (notice: LoginNotice) => void;
}

/**
 * Why a sign-in could not be begun or did not finish. The code names the seam
 * condition, not a protocol condition: the protocol's own failures cross this
 * boundary untouched so their message reaches the human unedited.
 */
export class CopilotSignInError extends Error {
  constructor(
    message: string,
    readonly code: "NO_FLOW" | "ALREADY_IN_FLIGHT" | "UNKNOWN_METHOD" | "CANCELLED",
  ) {
    super(message);
    this.name = "CopilotSignInError";
  }
}

/**
 * What to say when dsh has no flow for this record.
 *
 * The commonest cause is the `llm-pi-ai` row not being mounted, so the message
 * names that row rather than the seam: the user cannot register a flow by hand.
 */
export const NO_FLOW_TEXT =
  "dsh 没有为 llm-pi-ai/github-copilot 注册授权流——llm-pi-ai 行是否挂载？";

/** The notice shown while the enterprise prompt is answered with github.com. */
export const ENTERPRISE_UNSUPPORTED_TEXT = "Enterprise 不支持，本包固定 github.com";

/**
 * The one prompt pi-ai's Copilot login asks before it starts: a GitHub
 * Enterprise domain, blank for github.com. This package supports github.com
 * only — a stored `enterpriseUrl` is refused by `grant.ts` — so the prompt is
 * answered with the empty string rather than put to the human.
 */
const ENTERPRISE_PROMPT = /enterprise/i;

/**
 * The interaction that carries one attempt's conversation.
 *
 * `notify` is a straight translation. `prompt` recognises the enterprise
 * question and answers it; anything else is declined with
 * {@link AuthorizationDeclinedError}, the seam's only signal that the human (or
 * this surface on their behalf) said no. That distinction matters: a decline
 * settles the attempt as `cancelled`, while any other throw is a breakage the
 * caller should see, so an unanswerable prompt must not be answered with a
 * guess.
 */
function interactionFor(request: CopilotSignInRequest): AuthorizationInteraction {
  return {
    notify(notice: AuthorizationNotice): void {
      if (notice.url !== undefined && notice.code !== undefined) {
        request.onNotice({
          kind: "device-code",
          userCode: notice.code,
          verificationUri: notice.url,
        });
        return;
      }
      request.onNotice({ kind: "progress", message: notice.message });
    },
    prompt(prompt: AuthorizationPrompt): Promise<string> {
      if (prompt.kind === "text" && ENTERPRISE_PROMPT.test(prompt.message)) {
        request.onNotice({ kind: "info", message: ENTERPRISE_UNSUPPORTED_TEXT });
        return Promise.resolve("");
      }
      return Promise.reject(
        new AuthorizationDeclinedError(
          "copilot-auth: this package answers only the GitHub Enterprise prompt and declines every other question",
        ),
      );
    },
  };
}

/**
 * Translate a `begin()` rejection into the text the command surface reports.
 *
 * The seam's failure codes are machine-routable, not user-facing, and three of
 * them have one obvious next step each. Everything else — a flow that failed
 * mid-protocol, a `NOT_COMMITTED` contract violation — is returned unchanged so
 * its own message survives to the human.
 *
 * @param error - whatever `begin()` rejected with.
 * @returns the error to throw in its place.
 */
function mapBeginFailure(error: unknown): unknown {
  if (error instanceof AuthorizationError) {
    if (error.code === "NO_FLOW") return new CopilotSignInError(NO_FLOW_TEXT, "NO_FLOW");
    if (error.code === "ALREADY_IN_FLIGHT") {
      return new CopilotSignInError(
        "已有一个 GitHub Copilot 登录正在进行；请先完成它，或运行 /copilot-status 查看进度。",
        "ALREADY_IN_FLIGHT",
      );
    }
    if (error.code === "UNKNOWN_METHOD") {
      return new CopilotSignInError(
        "dsh 的 GitHub Copilot 授权流没有提供 oauth 方法，无法发起登录。",
        "UNKNOWN_METHOD",
      );
    }
  }
  return error;
}

/**
 * Start one GitHub Copilot sign-in through dsh's authorization seam.
 *
 * The call resolves only when the flow has committed the record for
 * `llm-pi-ai/github-copilot` during this attempt — the seam confirms the commit
 * before reporting `authorized` — so the caller may re-read the credential
 * store immediately afterwards and find what was written. Nothing here writes
 * it: doing so would make this package a second writer of a record the seam
 * already observes, which is exactly the race the seam exists to prevent.
 *
 * @param authorization - `ctx.authorization`, or undefined in a composition
 *   that does not mount the seam; an absent service is reported as `NO_FLOW`.
 * @param request - the cancellation signal and the notice sink.
 * @throws {CopilotSignInError} with `NO_FLOW`, `ALREADY_IN_FLIGHT`,
 *   `UNKNOWN_METHOD` or `CANCELLED` for the seam conditions this package can
 *   name, and the flow's own error otherwise.
 */
export async function beginCopilotSignIn(
  authorization: AuthorizationService | undefined,
  request: CopilotSignInRequest,
): Promise<void> {
  if (authorization === undefined || typeof authorization.begin !== "function") {
    throw new CopilotSignInError(NO_FLOW_TEXT, "NO_FLOW");
  }
  let outcome: AuthorizationOutcome;
  try {
    outcome = await authorization.begin({
      key: COPILOT_RECORD_KEY,
      method: "oauth",
      interaction: interactionFor(request),
      signal: request.signal,
    });
  } catch (error) {
    throw mapBeginFailure(error);
  }
  if (outcome.status === "cancelled") {
    throw new CopilotSignInError(
      "GitHub Copilot 登录已取消：授权问题的回答被拒绝，或调用方撤销了本次登录。",
      "CANCELLED",
    );
  }
}
