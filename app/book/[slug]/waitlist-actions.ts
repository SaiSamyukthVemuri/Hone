"use server";

import { headers } from "next/headers";
import { getStudioBySlug } from "@/lib/booking/queries";
import {
  isNewClientWaitlistEnabled,
  validateWaitlistSubmission,
  NEW_CLIENT_WAITLIST_SUBMIT_FAILED,
  WAITLIST_SLUG_MAX,
} from "@/lib/booking/new-client-waitlist";
import { limitWaitlistSubmit, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
import { sendEmailSafely } from "@/lib/email/send-appointment";
import {
  buildNewClientWaitlistClientEmail,
  buildNewClientWaitlistStudioEmail,
} from "@/lib/email/templates/new-client-waitlist";
import { hashFingerprint } from "@/lib/portal/tokens";
import type { Studio } from "@/lib/types/database";

// ===========================================================================
// P0 EMERGENCY — PUBLIC NEW-CLIENT WAITLIST SUBMIT
// ===========================================================================
//
// ZERO BUSINESS DATABASE WRITES. This action performs exactly one database
// operation: the SELECT inside getStudioBySlug. It creates no client, no
// appointment, no intake, no notification row, and it does NOT touch
// `public.waitlist` (that table is the Hone marketing/landing-page early-access
// list — a different product concept with global email uniqueness and no studio
// ownership; reusing it would silently mix studio booking leads into marketing
// signups). Durable storage is V2's job under a separately authorised migration.
//
// THE COMMIT POINT. V1's operational record is the studio notification email
// accepted by the provider. So:
//
//   studio email provider accepted AND returned a message id
//                                     -> this action may return success
//   studio email provider REJECTED / TIMED OUT / FAILED / UNCONFIGURED,
//     OR accepted without a message id
//                                     -> this action MUST return failure
//
// "Accepted" means the Resend API accepted the send request AND handed back an
// id for it. It does NOT mean inbox delivery, recipient acceptance, non-spam
// placement, or that a human saw it. Inbox delivery is proven separately, by a
// human, before a studio is activated.
//
// The message id is load-bearing HERE specifically because there is no durable
// queue to fall back on; see the commit point below.
//
// The client's own confirmation is BEST EFFORT and strictly after that commit:
// the business already has the request, so a failed acknowledgement must not
// discard it. A failed STUDIO send, by contrast, is a hard failure and no
// client confirmation is attempted — we never tell someone they are on a
// waitlist that nobody received.
//
// PII. Name / email / phone belong in these two emails and NOWHERE else. No
// log line, analytics event, ops alert, URL or error message authored here
// carries them — including provider error strings, which can embed the
// recipient address, so only the `retryable` classification is recorded.
// ===========================================================================

export type NewClientWaitlistResult = { ok: true } | { ok: false; error: string };

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Bounded, PII-free structured log. `emailFingerprint` is the existing salted
 * SHA-256 (never reversible to an address) so repeated failures for one
 * visitor can be correlated without writing their email anywhere.
 */
function logWaitlistEvent(
  event: string,
  detail: Record<string, string | number | boolean | null>,
): void {
  console.error(
    JSON.stringify({ event, ...detail, timestamp: new Date().toISOString() }),
  );
}

/**
 * The studio-side operational recipient.
 *
 * `studios.owner_email` is the studio's own account address and the existing
 * authoritative studio-level destination in this codebase (it is what the
 * portal-reply and postcare notification paths ultimately fall back to). It is
 * deliberately NOT `postcare_contact_email`: that field is the CLIENT-FACING
 * address a studio publishes for aftercare questions, and an internal
 * admission-control notice does not belong there.
 *
 * The public booking confirmation notifies the ASSIGNED PRACTITIONER instead,
 * but a waitlist request has no appointment and therefore no assignment, so
 * the studio-level address is the only correct destination.
 */
function studioNotificationRecipient(studio: Studio): string | null {
  const owner = studio.owner_email?.trim() ?? "";
  if (owner.length === 0 || !owner.includes("@")) return null;
  return owner;
}

/** Studio-local, human-readable "when did this arrive". No PII. */
function joinedAtLabel(now: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      dateStyle: "full",
      timeStyle: "short",
    }).format(now);
  } catch {
    // An unusable studio timezone must not cost the studio the request.
    return now.toISOString();
  }
}

export async function submitNewClientBookingWaitlistAction(
  formData: FormData,
): Promise<NewClientWaitlistResult> {
  // The browser supplies the slug ONLY as a lookup pointer. Studio id, the
  // notification address, and whether the feature is on are server-resolved
  // facts below and are never read off the form.
  const slug = trimmed(formData.get("slug"));

  // 1. BOUNDED VALIDATION FIRST. Everything downstream (the rate limiter's
  //    email dimension, the studio lookup, the templates) then works on
  //    length-capped, normalized input.
  const validated = validateWaitlistSubmission({
    name: trimmed(formData.get("name")),
    email: trimmed(formData.get("email")),
    phone: trimmed(formData.get("phone")) || null,
  });
  if (!validated.ok) return { ok: false, error: validated.error };
  if (!slug || slug.length > WAITLIST_SLUG_MAX) {
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }
  const submission = validated.value;
  const emailFingerprint = hashFingerprint(submission.email);

  // 2. RATE LIMIT before any lookup or send. Reuses the existing public
  //    marketing-form limiter: 5/hour per IP + 2/day per normalized email,
  //    both identifiers hashed inside the limiter, generic refusal copy, and
  //    fail-open when Upstash is unconfigured or down. No email is sent when
  //    limited. Not weakened, not re-implemented.
  const gate = await limitWaitlistSubmit({
    headers: await headers(),
    email: submission.email,
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  // 3. SERVER-RESOLVED STUDIO. getStudioBySlug throws on a read error; a
  //    database problem must surface as the same generic refusal as an unknown
  //    slug, never as a leaked driver message.
  let studio: Studio | null = null;
  try {
    studio = await getStudioBySlug(slug);
  } catch {
    logWaitlistEvent("new_client_waitlist_studio_lookup_failed", { slug });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }
  if (!studio) return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };

  // 4. INDEPENDENT SERVER FEATURE VERIFICATION against the slug as stored on
  //    the studios row. A browser-claimed "waitlist is on" is not consulted
  //    and does not exist on the wire.
  if (!isNewClientWaitlistEnabled(studio.slug)) {
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  const recipient = studioNotificationRecipient(studio);
  if (!recipient) {
    // No operational destination: the request would vanish. Fail truthfully
    // rather than telling the visitor they are on a waitlist.
    logWaitlistEvent("new_client_waitlist_no_studio_recipient", {
      studioId: studio.id,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // 5. STUDIO NOTIFICATION — the commit point. Sent FIRST and fail-closed.
  const studioEmail = buildNewClientWaitlistStudioEmail({
    studioName: studio.name,
    name: submission.name,
    email: submission.email,
    phone: submission.phone,
    joinedAtLabel: joinedAtLabel(new Date(), studio.timezone),
  });
  const studioSend = await sendEmailSafely({
    to: recipient,
    subject: studioEmail.subject,
    html: studioEmail.html,
    text: studioEmail.text,
  });
  if (!studioSend.ok) {
    // `studioSend.error` is a provider string that can embed the recipient
    // address; only the bounded classification is recorded.
    logWaitlistEvent("new_client_waitlist_studio_email_failed", {
      studioId: studio.id,
      retryable: studioSend.retryable,
      emailFingerprint,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // ACCEPTANCE MUST BE PROVABLE, NOT MERELY UNREJECTED.
  //
  // sendEmailSafely returns `{ ok: true, messageId: result.data?.id }`. Both
  // `data` and `data.id` are optional in the provider envelope, so a response
  // that carries no error AND no usable id yields `{ ok: true, messageId:
  // undefined }` — "the provider did not say no", which is not the same as
  // "the provider took custody".
  //
  // For a normal transactional email that distinction is tolerable: the
  // appointment row is the durable record and the send is an announcement.
  // V1 HAS NO DURABLE QUEUE. The provider-accepted studio email IS the entire
  // operational record of this request, so an acceptance we cannot point at is
  // indistinguishable from a request that was silently dropped — and the
  // visitor would have been told they are on a waitlist that may not exist.
  //
  // So the commit point requires a non-empty message id. Fail-closed: the same
  // generic refusal, no client confirmation, no success state. A distinct event
  // name keeps this separable from a provider REJECTION in the logs, because
  // the two mean very different things operationally.
  const studioMessageId =
    typeof studioSend.messageId === "string" ? studioSend.messageId.trim() : "";
  if (studioMessageId.length === 0) {
    logWaitlistEvent("new_client_waitlist_studio_email_unconfirmed", {
      studioId: studio.id,
      emailFingerprint,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // 6. CLIENT CONFIRMATION — best effort, strictly after the commit. Its
  //    failure (or an unexpected throw) never flips the result: the studio
  //    already has the request.
  try {
    const clientEmail = buildNewClientWaitlistClientEmail({
      studioName: studio.name,
      name: submission.name,
    });
    const clientSend = await sendEmailSafely({
      to: submission.email,
      subject: clientEmail.subject,
      html: clientEmail.html,
      text: clientEmail.text,
    });
    if (!clientSend.ok) {
      logWaitlistEvent("new_client_waitlist_client_email_failed", {
        studioId: studio.id,
        retryable: clientSend.retryable,
        emailFingerprint,
      });
    }
  } catch {
    logWaitlistEvent("new_client_waitlist_client_email_threw", {
      studioId: studio.id,
      emailFingerprint,
    });
  }

  return { ok: true };
}
