import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import type { ClientPortalMessageReply } from "@/lib/types/database";

// Practitioner-side read of every client reply for one client. PR
// #129. Always scoped by (studioId, clientId); callers must resolve
// studioId from getCurrentPractitionerWithStudio() rather than
// accepting it from form data.
//
// We surface the studio-facing audit columns (practitioner_seen_at,
// notification_email_*) so the client profile card can render the
// "Unread"/"Seen" + "Email sent"/"Email failed" badges. Soft-archived
// replies are NOT filtered here because the practitioner UI may want
// to render them in a muted state in a future PR; for now the card
// hides archived rows in memory. Order is ascending by created_at so
// the conversation reads top-down inside each parent message.

export type PortalMessageReplyForPractitioner = Pick<
  ClientPortalMessageReply,
  | "id"
  | "message_id"
  | "body"
  | "created_at"
  | "practitioner_seen_at"
  | "notification_email_sent_at"
  | "notification_email_error"
  | "archived_at"
>;

export async function getPortalMessageRepliesForPractitionerView(
  studioId: string,
  clientId: string,
): Promise<PortalMessageReplyForPractitioner[]> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("client_portal_message_replies")
    .select(
      "id, message_id, body, created_at, practitioner_seen_at, notification_email_sent_at, notification_email_error, archived_at",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("created_at", { ascending: true });
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_message_replies_for_practitioner_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return [];
  }
  return (data ?? []) as PortalMessageReplyForPractitioner[];
}
