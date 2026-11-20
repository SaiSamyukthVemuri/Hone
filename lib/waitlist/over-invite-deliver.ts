import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { deliverInvitation, recordObservedDelivery } from "@/lib/waitlist/invite-to-book-adapter";
import type { IssuedInvitation } from "@/lib/waitlist/over-invite-port";
import type { DeliveryState } from "@/lib/waitlist/over-invite-worker";

// Delivery for the over-invite batch. It uses the SAME functions today's single invite uses: `deliverInvitation` (the reviewed email path, which
// refuses an expired invitation before any provider call) and `recordObservedDelivery` (the durable outcome). There is no second implementation of
// either, and NO SMS is sent from here: the invitation text path (`sendWaitlistInvitationSms`) is deliberately not imported.
//
// The eligibility of an entry to be invited is the database's `admit_new_client_waitlist_entry` for BOTH paths (status, follow-up, batch state,
// round). `mayStillSend` below is only the cheap re-read of the facts the email itself needs, run immediately before the command.

export const ELIGIBLE_ENTRY_STATUSES: readonly string[] = ["waiting", "invited"];

/** The stored address, read server-side from the entry in the studio. Never taken from a form or a request. */
async function storedAddress(studioId: string, entryId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from("new_client_waitlist_entries")
    .select("email,status")
    .eq("id", entryId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error || !data) return null;
  const row = data as { email?: unknown; status?: unknown };
  return typeof row.email === "string" && row.email.length > 0 ? row.email : null;
}

/** `sendable`; `not_sendable` is a DEFINITIVE answer (entry gone, no address, or no longer waiting/invited); `read_failed` means the read itself failed, which says nothing about the entry. */
export type Sendability = "sendable" | "not_sendable" | "read_failed";

export async function mayStillSend(studioId: string, entryId: string): Promise<Sendability> {
  const { data, error } = await createAdminClient()
    .from("new_client_waitlist_entries")
    .select("email,status")
    .eq("id", entryId)
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) return "read_failed";
  if (!data) return "not_sendable"; // no such entry in this studio: a definitive answer
  const row = data as { email?: unknown; status?: unknown };
  return typeof row.email === "string" && row.email.length > 0 && typeof row.status === "string" && ELIGIBLE_ENTRY_STATUSES.includes(row.status) ? "sendable" : "not_sendable";
}

export async function deliverIssued(studioId: string, issued: IssuedInvitation, entryId: string): Promise<DeliveryState> {
  const admin = createAdminClient();
  const { data: studio } = await admin
    .from("studios")
    .select("id,name,postcare_contact_email,owner_email")
    .eq("id", studioId)
    .maybeSingle();
  if (!studio) return "unknown";
  const recipientEmail = issued.deliveryEmail ?? (await storedAddress(studioId, entryId));
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
