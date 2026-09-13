import { credentialKey, type CredentialKey } from "@deepseek-ai/dsh-credentials";

/**
 * The pi-ai provider id, which is also the harness route key.
 *
 * This package registers no route of its own: dsh already serves every
 * installed pi-ai catalog provider, `github-copilot` included, from whatever
 * `llm-pi-ai:` provider profiles the user's `settings.yaml` (or the Models
 * page) declares. A second adapter for the same key would only make the route
 * set ambiguous, and the profile would fail rather than serve. What dsh does
 * not ship is a way to *obtain* the subscription grant — and that, plus the
 * honest reporting around it, is the whole of this package.
 */
export const COPILOT_PROVIDER_ID = "github-copilot";

/**
 * The credential-record scope the pi-ai adapter family owns.
 *
 * It is `llm-pi-ai` because that is the plugin that reads this record at
 * request time (`recordKeyFor(providerId)`), so a grant written under any
 * other scope would be invisible to the route that needs it.
 */
const ADAPTER_SCOPE = "llm-pi-ai";

/**
 * The one credential record a Copilot sign-in writes and the stock route reads.
 *
 * Both halves of this package address it through this constant, and
 * `test/verify-grant.mjs` pins it against `recordKeyFor("github-copilot")` from
 * `@deepseek-ai/dsh-llm-pi-ai`, so a change to that package's addressing is a
 * failing check here rather than a sign-in that silently authenticates nothing.
 */
export const COPILOT_RECORD_KEY: CredentialKey = credentialKey(ADAPTER_SCOPE, COPILOT_PROVIDER_ID);

/**
 * The only API host a stored grant may point at.
 *
 * A Copilot access token carries its endpoint inside itself, as a
 * `proxy-ep=<host>` field, and pi-ai derives the request base URL from it. A
 * record naming any other host would therefore send every conversation —
 * prompts, files, tool output — to that host, which is why this package treats
 * a grant pointing anywhere else as not signed in at all.
 */
export const OFFICIAL_PROXY_HOST = "proxy.individual.githubcopilot.com";
