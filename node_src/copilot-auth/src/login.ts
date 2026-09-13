import { OFFICIAL_PROXY_HOST } from "./constants.js";
import { proxyHostOf, validateGrant, type CopilotGrant } from "./grant.js";
import { safeMessage } from "./redact.js";

/**
 * One thing the sign-in flow wants the human to see while it runs.
 *
 * The device-code step is the only one carrying two facts at once — where to go
 * and what to type there — which is why it keeps its `code` beside its URL
 * instead of folding both into a sentence.
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

/** One sign-in attempt's inputs. */
export interface LoginRequest {
  /** Aborts the whole flow — the device-code poll included. */
  readonly signal: AbortSignal;
  /** Called as the flow reports progress. Must not throw. */
  readonly onNotice: (notice: LoginNotice) => void;
  /**
   * Fetch implementation, defaulting to the global one.
   *
   * It is injectable for two reasons: the committed check drives the whole
   * state machine against a scripted transport with no network, and a
   * deployment behind a proxy can hand in an implementation carrying its own
   * dispatcher instead of hoping the runtime reads `HTTPS_PROXY`.
   */
  readonly fetch?: typeof globalThis.fetch;
  /** The OAuth client to authorize as; defaults to {@link COPILOT_CLIENT_ID}. */
  readonly clientId?: string;
  /** Seconds between polls when the issuer does not name an interval. */
  readonly pollIntervalSeconds?: number;
}

/** Why a sign-in could not produce a usable grant. */
export class CopilotAuthError extends Error {
  constructor(
    message: string,
    readonly code: "DEVICE_CODE" | "DENIED" | "EXPIRED" | "CANCELLED" | "TOKEN_EXCHANGE" | "INVALID_GRANT",
  ) {
    super(message);
    this.name = "CopilotAuthError";
  }
}

/**
 * GitHub's public client id for the Copilot editor integration.
 *
 * This is an identifier, not a credential: it is the value GitHub's own client
 * tooling sends, it is what the device-code endpoint expects alongside the
 * scope, and it grants nothing on its own — the human still has to authorize in
 * a browser, and what comes back is bound to *their* account. It is a constant
 * here rather than a config knob so a misconfigured deployment cannot silently
 * sign in against something else; if GitHub ever retires it, this is the one
 * line to change.
 */
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

/** Where the device flow starts and polls. */
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/**
 * Where a GitHub token is exchanged for the short-lived Copilot API token.
 *
 * This is the endpoint pi-ai's own refresh uses for a github.com grant, so a
 * grant written here refreshes through the same path the stock route already
 * takes at request time.
 */
const GITHUB_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";

/**
 * The headers the Copilot editor endpoint recognizes.
 *
 * The token exchange and the model listing are editor-internal APIs, and they
 * answer an editor identity rather than a bare bearer token. These are the same
 * values pi-ai sends.
 */
const COPILOT_HEADERS: Record<string, string> = {
  Accept: "application/json",
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

/** How long before the Copilot token's own expiry the grant is treated as stale. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** Sleep, rejecting as soon as the signal aborts. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new CopilotAuthError("the sign-in was cancelled", "CANCELLED"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/** One JSON response, with a bounded and redacted failure for anything that is not 2xx. */
async function requestJson(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, { ...init, signal, redirect: "error" });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new CopilotAuthError(`${url} answered HTTP ${String(response.status)}: ${safeMessage(body)}`, "TOKEN_EXCHANGE");
  }
  const json: unknown = await response.json().catch(() => undefined);
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    throw new CopilotAuthError(`${url} answered with a body that is not a JSON object`, "TOKEN_EXCHANGE");
  }
  return json as Record<string, unknown>;
}

/** One form-encoded POST. */
function postForm(
  url: string,
  fields: Record<string, string>,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch,
): Promise<Record<string, unknown>> {
  return requestJson(
    url,
    {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    },
    signal,
    fetchImpl,
  );
}

/** The Copilot API base URL a token names, derived exactly as pi-ai derives it. */
function baseUrlOf(copilotToken: string): string {
  const host = proxyHostOf(copilotToken);
  if (host === undefined) {
    throw new CopilotAuthError("the Copilot token names no endpoint, so there is nothing to call", "TOKEN_EXCHANGE");
  }
  if (host !== OFFICIAL_PROXY_HOST) {
    throw new CopilotAuthError(`the Copilot token names the endpoint ${host}, which is not the official one`, "INVALID_GRANT");
  }
  return `https://${host.replace(/^proxy\./, "api.")}`;
}

/**
 * Best-effort read of the models this account may use.
 *
 * A failure here must not fail the sign-in: this list is advisory — it is what
 * the status report shows and what a later refresh could narrow a picker with —
 * while the grant is the thing that makes the route work at all.
 */
async function availableModelIds(
  baseUrl: string,
  copilotToken: string,
  signal: AbortSignal,
  fetchImpl: typeof globalThis.fetch,
): Promise<string[] | undefined> {
  const body = await requestJson(`${baseUrl}/models`, { headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${copilotToken}` } }, signal, fetchImpl);
  const data = Array.isArray(body["data"]) ? (body["data"] as unknown[]) : [];
  const ids = data.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const model = entry as Record<string, unknown>;
    const policy = model["policy"];
    const state = typeof policy === "object" && policy !== null ? (policy as Record<string, unknown>)["state"] : undefined;
    return state === "enabled" && typeof model["id"] === "string" ? [model["id"]] : [];
  });
  return ids.length === 0 ? undefined : ids;
}

/**
 * Run one GitHub Copilot sign-in and return the grant it produced.
 *
 * The protocol is GitHub's device grant followed by the Copilot token exchange:
 * ask for a device code, show it, poll until the human authorizes, exchange the
 * resulting GitHub token for the short-lived Copilot token the API takes, and
 * read the account's model list on a best-effort basis. No step is skipped and
 * nothing is inferred: the grant this returns carries exactly the fields the
 * stock `llm-pi-ai` route reads, including the refresh token it will later
 * exchange on its own.
 *
 * This package deliberately does not import pi-ai to run this. That dependency
 * would be the same code path, but it also brings an editor-plugin dependency
 * tree into every install and ties this sign-in to one upstream version; the
 * whole protocol is the four calls above, and the *result* — not the code — is
 * what has to stay compatible with the adapter.
 *
 * @param request - signal, notice sink, and the injectable transports.
 * @returns the validated grant.
 * @throws {CopilotAuthError} for every refusal this package can name, and the
 *   abort reason when the caller's signal fires.
 */
export async function loginCopilot(request: LoginRequest): Promise<CopilotGrant> {
  const fetchImpl = request.fetch ?? globalThis.fetch;
  const clientId = request.clientId ?? COPILOT_CLIENT_ID;
  const signal = request.signal;

  const device = await postForm(DEVICE_CODE_URL, { client_id: clientId, scope: "read:user" }, signal, fetchImpl);
  const deviceCode = device["device_code"];
  const userCode = device["user_code"];
  const verificationUri = device["verification_uri"];
  const expiresIn = typeof device["expires_in"] === "number" ? device["expires_in"] : 900;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    throw new CopilotAuthError("github.com did not return a device code, a user code and a verification URL", "DEVICE_CODE");
  }
  request.onNotice({ kind: "device-code", userCode, verificationUri, expiresInSeconds: expiresIn });

  request.onNotice({ kind: "progress", message: "Waiting for the authorization to be confirmed in the browser…" });
  let intervalMs = (typeof device["interval"] === "number" ? device["interval"] : (request.pollIntervalSeconds ?? 5)) * 1000;
  const deadline = Date.now() + expiresIn * 1000;
  // GitHub answers the first poll with `authorization_pending` unless the human
  // was impossibly fast, so the wait comes before the first poll rather than
  // after the first refusal.
  await delay(intervalMs, signal);
  let githubToken: string | undefined;
  while (githubToken === undefined) {
    if (Date.now() >= deadline) throw new CopilotAuthError("the device code expired before it was authorized", "EXPIRED");
    const poll = await postForm(
      ACCESS_TOKEN_URL,
      { client_id: clientId, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" },
      signal,
      fetchImpl,
    );
    const token = poll["access_token"];
    if (typeof token === "string" && token.length > 0) {
      githubToken = token;
      break;
    }
    const error = poll["error"];
    if (error === "authorization_pending") {
      await delay(intervalMs, signal);
      continue;
    }
    if (error === "slow_down") {
      intervalMs = (typeof poll["interval"] === "number" ? (poll["interval"] as number) : intervalMs / 1000 + 5) * 1000;
      await delay(intervalMs, signal);
      continue;
    }
    if (error === "expired_token") throw new CopilotAuthError("the device code expired before it was authorized", "EXPIRED");
    if (error === "access_denied") throw new CopilotAuthError("the authorization was denied in the browser", "DENIED");
    throw new CopilotAuthError(`the device flow failed: ${String(error ?? "no access token in the response")}`, "DEVICE_CODE");
  }

  request.onNotice({ kind: "progress", message: "Authorization received; exchanging it for a Copilot token…" });
  const exchanged = await requestJson(
    GITHUB_COPILOT_TOKEN_URL,
    { headers: { ...COPILOT_HEADERS, Authorization: `Bearer ${githubToken}` } },
    signal,
    fetchImpl,
  );
  const copilotToken = exchanged["token"];
  const expiresAt = exchanged["expires_at"];
  if (typeof copilotToken !== "string" || copilotToken.length === 0 || typeof expiresAt !== "number") {
    throw new CopilotAuthError("the Copilot token exchange returned no usable token or expiry", "TOKEN_EXCHANGE");
  }
  const baseUrl = baseUrlOf(copilotToken);

  let models: string[] | undefined;
  try {
    request.onNotice({ kind: "progress", message: "Reading this account's model list…" });
    models = await availableModelIds(baseUrl, copilotToken, signal, fetchImpl);
  } catch (error) {
    request.onNotice({
      kind: "progress",
      message: `could not read the account model list (${safeMessage(error)}); the model picker will show the full catalog`,
    });
  }

  const grant: CopilotGrant = {
    type: "oauth",
    access: copilotToken,
    refresh: githubToken,
    expires: expiresAt * 1000 - EXPIRY_MARGIN_MS,
    ...(models === undefined ? {} : { availableModelIds: models }),
  };
  if (!validateGrant(grant)) {
    throw new CopilotAuthError(
      "the sign-in finished but the grant it produced did not pass validation, so it was discarded (an unexpected endpoint, or a token without a usable expiry)",
      "INVALID_GRANT",
    );
  }
  return grant;
}
