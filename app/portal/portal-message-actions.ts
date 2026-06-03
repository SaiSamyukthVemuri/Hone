"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPortalSession } from "@/lib/portal/session";

// Portal-side server action that lets the authenticated client mark
// one of THEIR own portal messages as reviewed. Lives outside any
// /portal/<route> directory so it does not accidentally widen the
// middleware allowlist; server actions are POSTed to whatever page
// the binding <form> lives on, and the only binding is the portal
// home (/portal, already allowlisted).
//
// Security stance:
//   * Requires a valid portal session. No session → no-op-with-error.
//   * UPDATE is keyed on (id, studio_id, client_id, status,
//     archived_at, client_reviewed_at) so a forged message id from
//     another studio/client cannot be acknowledged from this
//     session, and an already-reviewed row is a no-op rather than
//     a re-stamp.
//   * Never trusts a client-supplied studio_id or client_id; both
//     come from the resolved session.

// Returns void: the action is bound directly to a server-side
// <form action={...}> on the portal home, which Next.js types as
// returning Promise<void>. On success the conditional UPDATE
// flips client_reviewed_at and the revalidatePath below triggers
// the portal home to re-render with the new "Reviewed" badge. On
// failure the row stays unreviewed and the page re-renders with
// the same Mark-as-reviewed button so the visitor can retry; we
// do not surface an inline error string because the only error
// path (DB failure) is rare and benign.
export async function markPortalMessageReviewedAction(
  formData: FormData,
): Promise<void> {
  const messageId = (formData.get("message_id") ?? "").toString().trim();
  if (!messageId) return;

  const session = await getCurrentPortalSession();
  if (!session) return;

  const admin = createAdminClient();
  const { error } = await admin
    .from("client_portal_messages")
    .update({ client_reviewed_at: new Date().toISOString() })
    .eq("id", messageId)
    .eq("studio_id", session.studioId)
    .eq("client_id", session.clientId)
    .eq("status", "published")
    .is("archived_at", null)
    .is("client_reviewed_at", null);
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_message_mark_reviewed_failed",
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  revalidatePath("/portal");
}
