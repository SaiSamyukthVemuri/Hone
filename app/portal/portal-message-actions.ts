"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPortalSession } from "@/lib/portal/session";
import { sendEmailSafely } from "@/lib/email/send-appointment";
import { postcareContactEmail } from "@/lib/email/send-appointment";
import { buildPortalReplyNotificationEmail } from "@/lib/email/templates/portal-reply-notification";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";
const REPLY_BODY_MIN = 1;
const REPLY_BODY_MAX = 5000;

// Truncated, sanitized failure marker for
// notification_email_error. Mirrors the helper in
// portal-messages-actions.ts (PR #124 / #127): an empty / whitespace-
// only error string collapses to a stable fallback so the
// practitioner card never reads a real failure as "Email not sent".
function shortReplyError(message: string | null | undefined): string {
  const trimmed = (message ?? "").trim().replace(/\s+/g, " ");
  const safe = trimmed.length > 0 ? trimmed : "Email send failed";
  return safe.length > 200 ? `${safe.slice(0, 197)}...` : safe;
}

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

// PR #129. Portal-side server action that lets the authenticated
// client post a reply to one specific parent message. Lives in this
// same file so the middleware allowlist does not need to widen; the
// binding <form> is on /portal (already allowlisted) and Next.js
// server actions POST to the page route they are bound to.
//
// Result shape mirrors the other portal actions so the UI can show
// inline error banners (DB outage, missing parent) without a redaction
// behind Next.js's production server-action error redaction.
export type CreatePortalReplyResult =
  | { ok: true; replyId: string; emailSent: boolean }
  | { ok: false; error: string };

// Critical security stance (PR #129 spec). The parent-message lookup
// MUST include all three of (id = messageId, studio_id =
// session.studioId, client_id = session.clientId) so a forged
// messageId from another studio/client cannot resolve to a row whose
// reply would be saved under the forger's session.
//
// In addition:
//   * The current clients row is re-verified as active + non-archived
//     before accepting the reply. A practitioner who archives a client
//     while the client still holds a live portal session cookie should
//     not see new replies arrive on the archived row.
//   * Parent message must be status='published' and archived_at IS
//     NULL. A practitioner who archives a parent should not see new
//     replies stack up under it.
//   * Insert uses session.studioId / session.clientId / messageId
//     verbatim; the client-supplied messageId is treated as opaque
//     input that has already been validated by the above lookup.
//   * Server-side body length is the source of truth; the UI's
//     maxLength attribute is a hint only.
export async function createPortalMessageReplyAction(
  formData: FormData,
): Promise<CreatePortalReplyResult> {
  const messageId = (formData.get("message_id") ?? "").toString().trim();
  const body = (formData.get("body") ?? "").toString().trim();

  if (!messageId) return { ok: false, error: "Missing message reference." };
  if (body.length < REPLY_BODY_MIN) {
    return { ok: false, error: "Reply text is required." };
  }
  if (body.length > REPLY_BODY_MAX) {
    return {
      ok: false,
      error: `Reply must be ${REPLY_BODY_MAX} characters or fewer.`,
    };
  }

  const session = await getCurrentPortalSession();
  if (!session) {
    return { ok: false, error: "Your portal session has expired." };
  }

  const admin = createAdminClient();

  // Defence in depth: verify the client row is still active and
  // belongs to this session's studio. A portal session cookie outlives
  // a studio-side archive action by design (we do not invalidate
  // cookies on archive); this check is the guardrail that stops an
  // archived client from posting new replies.
  const { data: client, error: clientErr } = await admin
    .from("clients")
    .select("id, archived_at")
    .eq("id", session.clientId)
    .eq("studio_id", session.studioId)
    .maybeSingle();
  if (clientErr) {
    console.error(
      JSON.stringify({
        event: "portal_reply_client_lookup_failed",
        code: clientErr.code,
        message: clientErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't post your reply. Please try again." };
  }
  if (!client || client.archived_at != null) {
    // Same generic error string the no-parent branch returns so the
    // exact failure reason is not leaked back to the client. The row
    // is not inserted.
    return { ok: false, error: "This conversation is no longer available." };
  }

  // Parent-message lookup with all three security clauses + the two
  // visibility clauses. The combination ensures the reply only
  // proceeds when (parent message belongs to this session's studio
  // and client AND is currently published AND not archived). Any
  // mismatch returns the generic "no longer available" error so a
  // probe of someone else's messageId returns the same string as a
  // probe of a deleted one.
  const { data: parent, error: parentErr } = await admin
    .from("client_portal_messages")
    .select("id, studio_id, client_id, subject")
    .eq("id", messageId)
    .eq("studio_id", session.studioId)
    .eq("client_id", session.clientId)
    .eq("status", "published")
    .is("archived_at", null)
    .maybeSingle();
  if (parentErr) {
    console.error(
      JSON.stringify({
        event: "portal_reply_parent_lookup_failed",
        code: parentErr.code,
        message: parentErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't post your reply. Please try again." };
  }
  if (!parent) {
    return { ok: false, error: "This conversation is no longer available." };
  }

  // Insert the reply. studio_id / client_id / message_id come from
  // server-resolved values; the client-supplied messageId was only
  // used as a lookup key above and is now redundantly the same value.
  // created_by defaults to 'client' via the column default but we set
  // it explicitly to be defensive against a future migration that
  // changes the default.
  const { data: created, error: insertErr } = await admin
    .from("client_portal_message_replies")
    .insert({
      studio_id: session.studioId,
      client_id: session.clientId,
      message_id: parent.id,
      body,
      created_by: "client",
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    console.error(
      JSON.stringify({
        event: "portal_reply_insert_failed",
        code: insertErr?.code,
        message: insertErr?.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't post your reply. Please try again." };
  }

  // Notification email to the studio side. Recipient priority per
  // spec:
  //   1. studio.postcare_contact_email
  //   2. studio.owner_email          (covered by postcareContactEmail)
  //   3. creating practitioner's email
  //   4. null  -> stamp notification_email_error, do NOT fail the
  //               reply itself (the spec is explicit: "log
  //               notification failure and still save reply")
  //
  // Body is never included in the email. The link drops the
  // practitioner into the existing client profile surface, which is
  // already auth-gated.
  let emailSent = false;
  let emailErrorString: string | null = null;

  const { data: studio, error: studioErr } = await admin
    .from("studios")
    .select("name, postcare_contact_email, owner_email")
    .eq("id", session.studioId)
    .maybeSingle();
  if (studioErr || !studio) {
    emailErrorString = shortReplyError(studioErr?.message ?? "Studio missing");
    console.error(
      JSON.stringify({
        event: "portal_reply_studio_lookup_failed",
        code: studioErr?.code,
        message: studioErr?.message,
        timestamp: new Date().toISOString(),
      }),
    );
  } else {
    let recipient = postcareContactEmail({
      postcare_contact_email: studio.postcare_contact_email,
      owner_email: studio.owner_email,
    });
    if (!recipient) {
      // Fall through to the creating-practitioner's email on the
      // parent message. This is a SELECT against practitioners
      // keyed by the parent message's author; a single round trip
      // is acceptable because we only fall here when the studio
      // has neither postcare_contact_email nor owner_email
      // configured (rare).
      const { data: parentAuthor } = await admin
        .from("client_portal_messages")
        .select("created_by_practitioner_id")
        .eq("id", parent.id)
        .maybeSingle();
      if (parentAuthor?.created_by_practitioner_id) {
        const { data: practitioner } = await admin
          .from("practitioners")
          .select("email")
          .eq("id", parentAuthor.created_by_practitioner_id)
          .maybeSingle();
        const practEmail = practitioner?.email?.trim();
        if (practEmail && practEmail.length > 0) {
          recipient = practEmail;
        }
      }
    }

    if (!recipient) {
      emailErrorString = "No studio email on file";
    } else {
      const clientProfileUrl =
        `${APP_ORIGIN}/clients/${encodeURIComponent(session.clientId)}`;
      const tmpl = buildPortalReplyNotificationEmail({
        studioName: studio.name,
        clientProfileUrl,
      });
      const sendResult = await sendEmailSafely({
        to: recipient,
        subject: tmpl.subject,
        html: tmpl.html,
        text: tmpl.text,
      });
      if (sendResult.ok) {
        emailSent = true;
      } else {
        emailErrorString = shortReplyError(sendResult.error);
        console.error(
          JSON.stringify({
            event: "portal_reply_email_send_failed",
            replyId: created.id,
            retryable: sendResult.retryable,
            error: sendResult.error,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  // Stamp the notification state in one UPDATE. Idempotent because
  // the reply row id is unique and the columns we touch are only
  // written here. Failure of the stamp itself does not roll back the
  // reply; the practitioner card simply renders "Email not sent" on
  // the next load.
  const stampPayload = emailSent
    ? {
        notification_email_sent_at: new Date().toISOString(),
        notification_email_error: null,
      }
    : {
        notification_email_sent_at: null,
        notification_email_error: emailErrorString,
      };
  const { error: stampErr } = await admin
    .from("client_portal_message_replies")
    .update(stampPayload)
    .eq("id", created.id)
    .eq("studio_id", session.studioId);
  if (stampErr) {
    console.error(
      JSON.stringify({
        event: "portal_reply_notification_stamp_failed",
        replyId: created.id,
        code: stampErr.code,
        message: stampErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
  }

  revalidatePath("/portal");
  return { ok: true, replyId: created.id, emailSent };
}
