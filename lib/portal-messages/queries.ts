import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type { ClientPortalMessage } from "@/lib/types/database";

// Practitioner-side read of the secure portal messages for one
// client. Always scoped by (studioId, clientId); callers must
// resolve studioId from getCurrentPractitionerWithStudio() rather
// than accepting it from form data.
//
// We select every column the practitioner card renders, including
// the notification_email_* audit fields so the card can show "Email
// sent" / "Email failed" badges. The body is selected here because
// the practitioner needs to see what they sent; the client portal
// side has its own narrower select shape (lib/portal/queries.ts).

export type PortalMessageForPractitioner = Pick<
  ClientPortalMessage,
  | "id"
  | "subject"
  | "body"
  | "status"
  | "published_at"
  | "client_reviewed_at"
  | "notification_email_sent_at"
  | "notification_email_error"
  | "archived_at"
  | "created_by_practitioner_id"
>;

export async function getPortalMessagesForPractitionerView(
  studioId: string,
  clientId: string,
): Promise<PortalMessageForPractitioner[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_portal_messages")
    .select(
      "id, subject, body, status, published_at, client_reviewed_at, notification_email_sent_at, notification_email_error, archived_at, created_by_practitioner_id",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("published_at", { ascending: false });
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_messages_for_practitioner_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  return (data ?? []) as PortalMessageForPractitioner[];
}
