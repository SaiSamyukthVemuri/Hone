import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { deliverInvitation, recordObservedDelivery } from "@/lib/waitlist/invite-to-book-adapter";
import type { IssuedInvitation } from "@/lib/waitlist/over-invite-port";
import type { DeliveryState } from "@/lib/waitlist/over-invite-worker";
import type { Reader } from "@/lib/waitlist/over-invite-shown";

// Delivery for the over-invite batch. It uses the SAME functions today's single invite uses: `deliverInvitation` (the reviewed email path, which
// refuses an expired invitation before any provider call) and `recordObservedDelivery` (the durable outcome). There is no second implementation of
// either, and NO SMS is sent from here: the invitation text path (`sendWaitlistInvitationSms`) is deliberately not imported.
//
// The eligibility of an entry to be invited is the database's `admit_new_client_waitlist_entry` for BOTH paths (status, follow-up, batch state,
// round); the command also returns the address it validated, so nothing here re-reads the entry through the service role (which has no table access).

/**
 * The stored address, read from the entry in the studio through a caller-supplied READER. It is only needed when the command's own answer carried no
 * address (a replace), and then only the owner's own session can supply one: `service_role` has NO table privilege on the waitlist entries by design
 * (the commands are the only service path), so an admin-client read here fails at the privilege layer. The background worker has no session and needs
 * none: the admit command returns the address it validated. Never taken from a form or a request.
 */
async function storedAddress(reader: Reader | undefined, studioId: string, entryId: string): Promise<string | null> {
  if (!reader) return null;
  const { data, error } = await reader.from("new_client_waitlist_entries").select("email,status").eq("id", entryId).eq("studio_id", studioId).maybeSingle();
  if (error || !data) return null;
  const row = data as { email?: unknown };
  return typeof row.email === "string" && row.email.length > 0 ? row.email : null;
}

export async function deliverIssued(studioId: string, issued: IssuedInvitation, entryId: string, reader?: Reader): Promise<DeliveryState> {
  const admin = createAdminClient();
  const { data: studio } = await admin
    .from("studios")
    .select("id,name,postcare_contact_email,owner_email")
    .eq("id", studioId)
    .maybeSingle();
  if (!studio) return "unknown";
  const recipientEmail = issued.deliveryEmail ?? (await storedAddress(reader, studioId, entryId));
  if (!recipientEmail) return "refused";
  const attempt = await deliverInvitation({
    studio: {
      id: studioId,
      name: (studio as { name?: string | null }).name ?? null,
      postcare_contact_email: (studio as { postcare_contact_email?: string | null }).postcare_contact_email ?? null,
      owner_email: (studio as { owner_email?: string | null }).owner_email ?? null,
    },
    invitationId: issued.invitationId,
    recipientEmail,
    rawToken: issued.rawToken,
    issuedAt: issued.issuedAt,
    expiresAt: issued.expiresAt,
  });
  await recordObservedDelivery(studioId, issued.invitationId, attempt);
  return attempt.state === "accepted" ? "accepted" : attempt.state === "refused" ? "refused" : "unknown";
}
