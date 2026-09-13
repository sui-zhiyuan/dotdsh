/**
 * Text safe to show a human.
 *
 * Two of this package's failures carry provider responses: the device flow's
 * polling errors and the token exchange. Those bodies are remote input, and a
 * failing exchange is exactly the case where the body is most likely to quote
 * the request back — including the `code` or a token. Everything this package
 * prints or returns to a human therefore goes through here first.
 *
 * This is a display filter, not a sandbox: it recognizes token-shaped material
 * it knows about (a JWT, and the `name=value` / `"name": "value"` spellings a
 * form-encoded or JSON error body uses) and bounds the length. It does not
 * understand every provider's error format, which is why nothing here is ever
 * the basis of a security decision — the one such decision, whether a grant may
 * be used, is made in `grant.ts` over the stored payload itself.
 *
 * @param error - whatever a failed call rejected with.
 * @returns one redacted, truncated line of text.
 */
export function safeMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/gu, "[redacted token]")
    .replace(
      /\b(access_token|refresh_token|id_token|device_code|client_secret|token|code)(["']?\s*[:=]\s*["']?)([^\s"'&,}]+)/giu,
      "$1$2[redacted]",
    )
    .slice(0, 1_000);
}
