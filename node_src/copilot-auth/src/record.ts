import type { CredentialKey, CredentialRecord } from "@deepseek-ai/dsh-credentials";
import { COPILOT_RECORD_KEY } from "./constants.js";
import { jsonImage, validateGrant, type CopilotGrant } from "./grant.js";

/**
 * The part of `ctx.credentials` this package uses.
 *
 * It is declared structurally rather than imported as the service class so the
 * committed checks can drive every decision with a two-method stand-in, and so
 * the CLI can hand in dsh's own provider instance without this module knowing
 * that a Cordis context exists.
 */
export interface CredentialRecords {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>;
  deleteRecord(key: CredentialKey): Promise<void>;
}

/** What the store currently holds for this sign-in. */
export interface StoredGrant {
  /** The usable grant, absent when nothing is stored or what is stored was refused. */
  readonly grant?: CopilotGrant;
  /**
   * True when a record exists but did not pass {@link validateGrant}. It is
   * reported rather than hidden because the user's next step differs: a
   * refused record has to be removed, while an absent one needs a sign-in.
   */
  readonly rejected: boolean;
}

/**
 * Read the stored sign-in.
 *
 * A record that is not a `grant`, or whose payload is refused, is reported as
 * present-but-unusable and never handed to the adapter: a route fed a forged
 * payload is worse than a route that reports itself signed out.
 *
 * @param credentials - the credential store to read.
 * @returns the usable grant, if any, and whether something was refused.
 */
export async function readStoredGrant(credentials: CredentialRecords): Promise<StoredGrant> {
  const record = await credentials.readRecord(COPILOT_RECORD_KEY);
  if (record === undefined) return { rejected: false };
  if (record.kind !== "grant" || !validateGrant(record.payload)) return { rejected: true };
  return { grant: record.payload, rejected: false };
}

/**
 * Store a sign-in as the record the stock route reads.
 *
 * The write goes through `modifyRecord` — the seam's only write path, and the
 * one that takes the credential document's cross-process lock — so this never
 * races dsh's own writes the way editing the file would. A grant that fails
 * validation is refused here rather than stored: the read path would refuse it
 * anyway, and a record that looks like a sign-in but authenticates nothing is
 * exactly the confusion this package exists to remove.
 *
 * @param credentials - the credential store to write.
 * @param grant - the grant the flow just produced.
 * @throws {TypeError} when the grant would not be usable after a round trip.
 */
export async function storeGrant(credentials: CredentialRecords, grant: CopilotGrant): Promise<void> {
  if (!validateGrant(grant)) throw new TypeError("copilot-auth: refusing to store a grant that fails validation");
  await credentials.modifyRecord(COPILOT_RECORD_KEY, () =>
    Promise.resolve({ kind: "grant", payload: jsonImage(grant) }),
  );
}

/**
 * Remove the stored sign-in, if there is one.
 *
 * @param credentials - the credential store to write.
 * @returns true when a record was removed. Removal is local only: revoking the
 *   GitHub authorization itself is the user's act on github.com.
 */
export async function clearGrant(credentials: CredentialRecords): Promise<boolean> {
  const record = await credentials.readRecord(COPILOT_RECORD_KEY);
  if (record === undefined) return false;
  await credentials.deleteRecord(COPILOT_RECORD_KEY);
  return true;
}
