import { OFFICIAL_PROXY_HOST } from "./constants.js";

/**
 * A stored Copilot grant: pi-ai's OAuth credential for the `github-copilot`
 * provider, which is what the stock `llm-pi-ai` route reads out of the harness
 * credential record `llm-pi-ai/github-copilot`.
 *
 * The type is narrow on purpose. The record is pi-ai's to define — the
 * credential seam treats a grant payload as opaque JSON — so this names only
 * the fields this package validates and reports, and {@link jsonImage} carries
 * everything else through untouched rather than pretending to understand it.
 */
export interface CopilotGrant {
  /** Discriminant pi-ai uses for an OAuth credential. */
  readonly type: "oauth";
  /** Short-lived Copilot API token; its `proxy-ep` field names the endpoint. */
  readonly access: string;
  /** GitHub token the adapter exchanges for a fresh {@link access}. */
  readonly refresh: string;
  /** Epoch milliseconds after which {@link access} is no longer usable. */
  readonly expires: number;
  /** Model ids the account may use, when the sign-in managed to learn them. */
  readonly availableModelIds?: readonly string[];
}

/**
 * The `proxy-ep` host an access token names, or undefined when it names none or
 * names something that is not a host.
 *
 * @param access - the Copilot access token.
 * @returns the hostname, lowercased by `URL` as usual.
 */
export function proxyHostOf(access: string): string | undefined {
  const match = /(?:^|;)proxy-ep=([^;]+)/.exec(access);
  if (match === null) return undefined;
  try {
    return new URL(`https://${match[1]}`).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Whether a stored payload is a grant this package is willing to treat as a
 * sign-in.
 *
 * This is the trust boundary for a value that arrives from disk rather than
 * from the flow that just ran. The record itself is written 0600 by the
 * credential store, so the threat is not a remote attacker: it is a record that
 * was hand-edited, restored from a backup of another machine, produced by a
 * *different* tool, or left behind by an earlier bug. Two of a grant's fields
 * decide where traffic goes, and neither is re-checked anywhere downstream:
 *
 * - `access` carries `proxy-ep`, which pi-ai turns into the request base URL.
 *   Every conversation this route serves — prompts, attachments, tool output —
 *   follows it, so any host but the official one is refused.
 * - `enterpriseUrl` is what pi-ai reads when it refreshes, and it builds the
 *   refresh endpoint from it while sending the refresh token as a bearer
 *   credential. A payload combining an official `proxy-ep` with an attacker
 *   `enterpriseUrl` would pass a check that trusted either field alone, so an
 *   `enterpriseUrl` is refused outright. This package never produces one: its
 *   flow answers pi-ai's enterprise prompt with the empty string, keeping every
 *   sign-in on github.com.
 *
 * Everything else here is shape: an empty token or a missing expiry would fail
 * later, inside a request, where the reason is far harder to see.
 *
 * @param value - the record payload as parsed from the credential document.
 * @returns true when the payload may be used as a sign-in.
 */
export function validateGrant(value: unknown): value is CopilotGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  if (grant["type"] !== "oauth") return false;
  if (typeof grant["access"] !== "string" || grant["access"].length === 0) return false;
  if (typeof grant["refresh"] !== "string" || grant["refresh"].length === 0) return false;
  if (typeof grant["expires"] !== "number" || !Number.isFinite(grant["expires"])) return false;
  const models = grant["availableModelIds"];
  if (models !== undefined && (!Array.isArray(models) || !models.every((id) => typeof id === "string"))) return false;
  const enterprise = grant["enterpriseUrl"];
  if (enterprise !== undefined && enterprise !== "") return false;
  return proxyHostOf(grant["access"]) === OFFICIAL_PROXY_HOST;
}

/**
 * Render a value as the JSON image the credential seam requires.
 *
 * The store insists a record payload survives a JSON round trip, and pi-ai's
 * credentials idiomatically carry absent members as explicit `undefined` — the
 * github.com Copilot grant holds `enterpriseUrl: undefined` — which
 * `JSON.stringify` drops from an object and turns into `null` inside an array.
 * Reproducing exactly that here means the record this package writes is one the
 * store accepts, and one a later read parses back into the same credential.
 *
 * @param value - any JSON-shaped value.
 * @returns its JSON image.
 */
export function jsonImage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => (entry === undefined ? null : jsonImage(entry)));
  if (typeof value === "object" && value !== null) {
    const image: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) if (member !== undefined) image[key] = jsonImage(member);
    return image;
  }
  return value;
}
