import "server-only";
import {
  type NewClientAdmission,
  newClientAdmissionIsCutOver,
} from "@/lib/booking/new-client-admission";
import { isNewClientWaitlistDurableEnabled } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// MIGRATION BRIDGE — DELETE THIS WHOLE FILE AT CUTOVER
// ===========================================================================
//
// THE DELETION POINT IS THE POINT OF THIS FILE. The second env list
// (NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS) is rollback compatibility, never
// an authority, so it is consulted from exactly ONE place and that place is a
// file whose name says it is temporary. When every waitlisted studio has been
// persisted through the new authority, delete this file, delete
// `NewClientAdmissionSource` and `newClientAdmissionIsCutOver` with it, and the
// durable path becomes unconditional - which is what `waitlist` means.
//
// WHY IT EXISTS AT ALL
// -------------------
// NEW-CLIENT-MODE-01 made `waitlist` MEAN durable, and the first version of it
// committed durably the moment the code deployed. That is correct as a
// long-term law and wrong as a deploy: a studio named in
// NEW_CLIENT_WAITLIST_STUDIO_SLUGS but NOT in the DURABLE list is a supported
// production configuration today, and its submissions commit by email
// acceptance. Deploying the code would have moved that studio's COMMIT POINT
// before anyone chose to move it, and before its durable mode was ever
// persisted - which also made the activation document's "deploy causes no
// behaviour change" untrue.
//
// So during the bridge the commit point follows the studio's CURRENT
// configuration, and after cutover it follows the persisted authority.
// ===========================================================================

/**
 * Must a permitted waitlist join commit DURABLY (a `new_client_waitlist_entries`
 * row) rather than through legacy email acceptance?
 *
 * Call this only for a join the admission authority has already PERMITTED -
 * `newClientMayJoinWaitlist` owns whether a join may happen at all, and
 * `closed` / `unknown` are refused there, never here. This answers the
 * narrower question of where a permitted join commits.
 *
 *   cut over (persisted mode)  -> ALWAYS durable, whatever either env list
 *                                 says. Once an owner has deliberately chosen
 *                                 WAITLIST through the new authority, removing
 *                                 the legacy durable slug must not quietly
 *                                 return that studio to email-only.
 *   on the legacy bridge       -> whatever that studio does in production
 *                                 TODAY, which is exactly the legacy durable
 *                                 list. Preserved so a deploy moves nothing.
 */
export function newClientWaitlistCommitIsDurable(
  admission: NewClientAdmission,
  studioSlug: string | null | undefined,
): boolean {
  // Defensive, not a gate: a non-waitlist admission has no join to commit, and
  // the caller has already refused it.
  if (!admission.ok || admission.mode !== "waitlist") return false;

  // LAW: persisted WAITLIST is durable, independent of the legacy durable list.
  if (newClientAdmissionIsCutOver(admission)) return true;

  // BRIDGE: preserve today's commit point for a studio nobody has cut over yet.
  return isNewClientWaitlistDurableEnabled(studioSlug);
}
