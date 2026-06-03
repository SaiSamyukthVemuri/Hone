"use server";

import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { sendEmailSafely } from "@/lib/email/send-appointment";
import { buildPortalMessageNotificationEmail } from "@/lib/email/templates/portal-message-notification";

const APP_ORIGIN = process.env.NEXT_PUBLIC_APP_ORIGIN ?? "https://hone.care";

const SUBJECT_MIN = 1;
const SUBJECT_MAX = 160;
const BODY_MIN = 1;
const BODY_MAX = 5000;

// Truncated, sanitized failure marker for the
// notification_email_error column. We never store the full error
// payload; the column is for the practitioner UI to surface a
// "send failed" badge, not for ops triage. A separate sanitized
// console.error captures the operator-side detail.
//
// Invariant: this function ALWAYS returns a non-empty string when
// called from a failure branch. The practitioner card distinguishes
// "Email failed" from "Email not sent" by the truthiness of
// notification_email_error, so a null / empty / whitespace-only
// input must collapse to a stable fallback rather than write an
// empty string to the row. A blank
// notification_email_error would otherwise mis-render as
// "Email not sent" and hide a real failure.
function shortError(message: string | null | undefined): string {
  const trimmed = (message ?? "").trim().replace(/\s+/g, " ");
  const safe = trimmed.length > 0 ? trimmed : "Email send failed";
  return safe.length > 200 ? `${safe.slice(0, 197)}...` : safe;
}

export type CreatePortalMessageResult =
  | { ok: true; messageId: string; emailSent: boolean }
  | { ok: false; error: string };

// Create a new secure portal message and dispatch the notification
// email in one server action. Idempotency:
//   * Each invocation creates a brand new client_portal_messages
//     row, so a double-submit produces two visible messages rather
//     than two emails for the same row. The UI debounces with
//     useTransition; this is the worst-case shape.
//   * The notification_email_sent_at column is stamped only on a
//     successful send. A future resend action would gate on
//     `notification_email_sent_at is null` before re-firing the
//     email; that resend flow is deferred per PR spec.
export async function createPortalMessageAction(
  formData: FormData,
): Promise<CreatePortalMessageResult> {
  const clientId = formDataStr(formData, "client_id");
  const subject = formDataStr(formData, "subject");
  const body = formDataStr(formData, "body");

  if (!clientId) return { ok: false, error: "Missing client id." };
  if (subject.length < SUBJECT_MIN) {
    return { ok: false, error: "Subject is required." };
  }
  if (subject.length > SUBJECT_MAX) {
    return {
      ok: false,
      error: `Subject must be ${SUBJECT_MAX} characters or fewer.`,
    };
  }
  if (body.length < BODY_MIN) {
    return { ok: false, error: "Message body is required." };
  }
  if (body.length > BODY_MAX) {
    return {
      ok: false,
      error: `Message body must be ${BODY_MAX} characters or fewer.`,
    };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot send messages." };
  }

  const admin = createAdminClient();

  // Defense in depth: verify the client belongs to this studio and
  // is not archived. The admin client bypasses RLS so the studio
  // check is the practitioner-side studio scope; archived clients
  // are excluded so a misclick on an archived row cannot dispatch
  // a message that the portal would never surface anyway.
  const { data: client, error: clientErr } = await admin
    .from("clients")
    .select("id, name, email, archived_at")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) {
    console.error(
      JSON.stringify({
        event: "portal_message_client_lookup_failed",
        code: clientErr.code,
        message: clientErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't load client. Please try again." };
  }
  if (!client) return { ok: false, error: "Client not found." };
  if (client.archived_at != null) {
    return {
      ok: false,
      error: "Archived clients cannot receive portal messages.",
    };
  }

  const { data: created, error: insertErr } = await admin
    .from("client_portal_messages")
    .insert({
      studio_id: studio.id,
      client_id: clientId,
      created_by_practitioner_id: practitioner.id,
      subject,
      body,
      status: "published",
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    console.error(
      JSON.stringify({
        event: "portal_message_insert_failed",
        code: insertErr?.code,
        message: insertErr?.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't save the message. Please try again." };
  }

  // Notification email: optional. Clients without an email on file
  // get the message in the portal but no email ping; we record that
  // as a failure on the row so the practitioner card can show
  // "Email not sent" rather than silently appearing to have sent
  // one. The portal login URL is the public sign-in surface, NOT a
  // direct verify link; possession of the email never grants portal
  // access.
  let emailSent = false;
  let emailErrorString: string | null = null;
  if (!client.email) {
    emailErrorString = "No email on file";
  } else {
    // Studio-scoped portal login URL (PR #126). A client whose
    // email is also active in another Hone studio cannot log into
    // this studio's portal via the bare /portal/login surface
    // because the multi-studio guard refuses to send a magic link
    // when more than one match exists. Scoping the URL to this
    // studio's slug routes the action through
    // findActiveClientsForStudioPortalLogin, which only matches in
    // this studio. studio.slug is the canonical public booking
    // slug already in use by /book/<slug>; we encode it because
    // slugs are URL-safe by convention but a future change might
    // relax that.
    const portalLoginUrl =
      `${APP_ORIGIN}/portal/login?studio=${encodeURIComponent(studio.slug)}`;
    const tmpl = buildPortalMessageNotificationEmail({
      studioName: studio.name,
      portalLoginUrl,
    });
    const sendResult = await sendEmailSafely({
      to: client.email,
      subject: tmpl.subject,
      html: tmpl.html,
      text: tmpl.text,
    });
    if (sendResult.ok) {
      emailSent = true;
    } else {
      emailErrorString = shortError(sendResult.error);
      console.error(
        JSON.stringify({
          event: "portal_message_email_send_failed",
          messageId: created.id,
          retryable: sendResult.retryable,
          error: sendResult.error,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  // Stamp the result. We use a single UPDATE so both success and
  // failure write their respective state to the row in one round
  // trip. The previous insert already established the row; this
  // UPDATE only changes notification_email_* columns.
  const updatePayload = emailSent
    ? {
        notification_email_sent_at: new Date().toISOString(),
        notification_email_error: null,
      }
    : {
        notification_email_sent_at: null,
        notification_email_error: emailErrorString,
      };
  const { error: stampErr } = await admin
    .from("client_portal_messages")
    .update(updatePayload)
    .eq("id", created.id)
    .eq("studio_id", studio.id);
  if (stampErr) {
    console.error(
      JSON.stringify({
        event: "portal_message_notification_stamp_failed",
        messageId: created.id,
        code: stampErr.code,
        message: stampErr.message,
        timestamp: new Date().toISOString(),
      }),
    );
    // The message row still exists with whatever the trigger /
    // defaults set. The practitioner UI will refresh and show the
    // notification state on the next load; we don't fail the entire
    // action just because a status stamp lagged.
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true, messageId: created.id, emailSent };
}

export type ArchivePortalMessageResult =
  | { ok: true }
  | { ok: false; error: string };

// Soft-archive a portal message. Archived messages disappear from
// the client portal (the portal query filters archived_at IS NULL)
// and render in a muted state on the practitioner card. Hard delete
// is intentionally not supported so the audit trail is preserved.
export async function archivePortalMessageAction(
  formData: FormData,
): Promise<ArchivePortalMessageResult> {
  const clientId = formDataStr(formData, "client_id");
  const messageId = formDataStr(formData, "message_id");
  if (!clientId) return { ok: false, error: "Missing client id." };
  if (!messageId) return { ok: false, error: "Missing message id." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return {
      ok: false,
      error: "Inactive practitioners cannot archive messages.",
    };
  }

  const admin = createAdminClient();
  const { error } = await admin
    .from("client_portal_messages")
    .update({
      archived_at: new Date().toISOString(),
      status: "archived",
    })
    .eq("id", messageId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) {
    console.error(
      JSON.stringify({
        event: "portal_message_archive_failed",
        messageId,
        code: error.code,
        message: error.message,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Couldn't archive the message." };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

function formDataStr(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v.trim() : "";
}
