import type { CopilotGrant } from "./grant.js";

/**
 * The lines both surfaces show for a stored sign-in.
 *
 * The `/copilot-status` command and `dotdsh-copilot-auth status` answer the
 * same question, so they answer it with the same words; only the framing around
 * these lines differs (`commands.ts` and `cli.ts` own that). The expiry is
 * rendered through `toISOString` rather than a locale format on purpose: it is
 * the one spelling that reads the same in a terminal, in a transcript, and in a
 * bug report.
 *
 * @param grant - the stored, already-validated grant.
 * @returns the shared lines, without a leading or trailing blank.
 */
export function grantSummaryLines(grant: CopilotGrant): string[] {
  const models = grant.availableModelIds ?? [];
  return [
    `Access token expires: ${new Date(grant.expires).toISOString()}`,
    models.length === 0
      ? "Account-enabled models: not recorded (the model picker shows the full catalog)"
      : `Account-enabled models (${models.length}): ${models.join(", ")}`,
  ];
}
