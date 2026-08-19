"use server";

import { headers } from "next/headers";
import { getStudioBySlug } from "@/lib/booking/queries";
import {
  isNewClientWaitlistEnabled,
  validateWaitlistSubmission,
  NEW_CLIENT_WAITLIST_SUBMIT_FAILED,
  NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED,
  WAITLIST_SLUG_MAX,
} from "@/lib/booking/new-client-waitlist";
import { limitNewClientBookingWaitlist, RATE_LIMIT_MESSAGE } from "@/lib/rate-limit/public";
import { sendWaitlistEmailIdempotent } from "@/lib/email/new-client-waitlist-send";
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
// ZERO BUSINESS DATABASE WRITES. Exactly one database operation: the SELECT
// inside getStudioBySlug. No client, no appointment, no intake, no
// notification row, and NOTHING in `public.waitlist` — that table is the Hone
// marketing early-access list (global email uniqueness, no studio ownership),
// a different product concept. Durable storage is V2's job under a separately
// authorised migration.
//
// THE COMMIT LAW. V1's operational record is the studio notification email
// accepted by the provider, so:
//
//   provider ACCEPTED, with a non-empty message id  -> success
//   provider REFUSED                                -> failure (known-not-sent)
//   provider AMBIGUOUS (timeout / concurrent / no
//     message id), after one idempotent retry       -> UNCONFIRMED
//
// "Accepted" means the Resend API accepted the request AND returned an id for
// it. It does NOT mean inbox delivery, recipient acceptance, non-spam
// placement, or that a human saw it. Inbox delivery is proven separately, by a
// human, before a studio is activated.
//
// AMBIGUITY IS ITS OWN ANSWER. A client-side timeout cannot cancel the request
// in flight, so "we could not confirm" is genuinely different from "it did not
// send". Telling the visitor to retry could duplicate a request that landed;
// telling them they joined could be a lie. They are pointed at a human, and
// the idempotency key means a retry cannot duplicate anyway.
//
// PII. Name / email / phone belong in the two emails and NOWHERE else. No log
// line, error message or event authored here carries them — nor the
// idempotency key, which is derived from them.
// ===========================================================================

export type NewClientWaitlistResult = { ok: true } | { ok: false; error: string };

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Bounded, PII-free structured log. Never carries the key or raw input. */
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
 * authoritative studio-level destination in this codebase (what the portal
 * reply and postcare paths ultimately fall back to). Deliberately NOT
 * `postcare_contact_email`: that is the CLIENT-FACING address a studio
 * publishes for aftercare questions, and an internal admission-control notice
 * does not belong there. Public booking notifies the ASSIGNED PRACTITIONER
 * instead, but a waitlist request has no appointment and so no assignment.
 */
function studioNotificationRecipient(studio: Studio): string | null {
  const owner = studio.owner_email?.trim() ?? "";
  if (owner.length === 0 || !owner.includes("@")) return null;
  return owner;
}

export async function submitNewClientBookingWaitlistAction(
  formData: FormData,
): Promise<NewClientWaitlistResult> {
  // The browser supplies the slug ONLY as a lookup pointer. Studio id, the
  // notification address, and whether the feature is on are server-resolved
  // below and are never read off the form.
  const slug = trimmed(formData.get("slug"));

  // 1. BOUNDED VALIDATION FIRST, so everything downstream works on
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

  // 2. SERVER-RESOLVED STUDIO, BEFORE the limiter.
  //    The limiter is studio-scoped, so it cannot run until the studio is a
  //    server fact. This costs one bounded, indexed SELECT on a public slug
  //    ahead of rate limiting — the same lookup the public booking PAGE
  //    already performs on every render, so it adds no new exposure.
  let studio: Studio | null = null;
  try {
    studio = await getStudioBySlug(slug);
  } catch {
    logWaitlistEvent("new_client_waitlist_studio_lookup_failed", { slug });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }
  if (!studio) return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };

  // 3. INDEPENDENT SERVER FEATURE VERIFICATION against the slug as stored on
  //    the row. A browser-claimed "waitlist is on" is not consulted and does
  //    not exist on the wire. Checked BEFORE the limiter so a submission to a
  //    studio that is not in waitlist mode consumes no quota.
  if (!isNewClientWaitlistEnabled(studio.slug)) {
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // 4. DEDICATED, STUDIO-SCOPED RATE LIMIT. Its own Redis namespace, keyed by
  //    hashed identifier + server-resolved studio id, so the marketing
  //    waitlist and other studios can never consume this studio's budget.
  const gate = await limitNewClientBookingWaitlist({
    headers: await headers(),
    studioId: studio.id,
    email: submission.email,
  });
  if (!gate.allowed) return { ok: false, error: RATE_LIMIT_MESSAGE };

  const recipient = studioNotificationRecipient(studio);
  if (!recipient) {
    // No operational destination: the request would vanish. Fail truthfully
    // rather than telling the visitor they are on a waitlist.
    logWaitlistEvent("new_client_waitlist_no_studio_recipient", {
      studioId: studio.id,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // 5. STUDIO NOTIFICATION — the commit point.
  const studioEmail = buildNewClientWaitlistStudioEmail({
    studioName: studio.name,
    name: submission.name,
    email: submission.email,
    phone: submission.phone,
  });
  // The sender derives the idempotency key from the payload it transmits, so
  // the key cannot drift from the bytes. Both email builders are pure
  // functions of the submission, which is what makes an identical
  // resubmission collapse instead of erroring.
  const studioSend = await sendWaitlistEmailIdempotent({
    namespace: "studio",
    to: recipient,
    subject: studioEmail.subject,
    html: studioEmail.html,
    text: studioEmail.text,
  });

  if (studioSend.status === "ambiguous") {
    // The provider may or may not have taken it, even after the one idempotent
    // retry. Distinct copy: never "you joined", never "just try again".
    logWaitlistEvent("new_client_waitlist_studio_email_unconfirmed", {
      studioId: studio.id,
      reason: studioSend.reason,
      emailFingerprint,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED };
  }
  if (studioSend.status !== "accepted") {
    // A definite refusal. `code` is the provider's error NAME (an enum member),
    // never its message, which can embed the recipient address.
    logWaitlistEvent("new_client_waitlist_studio_email_rejected", {
      studioId: studio.id,
      code: studioSend.code,
      emailFingerprint,
    });
    return { ok: false, error: NEW_CLIENT_WAITLIST_SUBMIT_FAILED };
  }

  // 6. CLIENT CONFIRMATION — courtesy only, strictly after the commit, under
  //    its OWN idempotency key. Any outcome, including a throw, leaves the
  //    result successful: the studio already holds the request and a failed
  //    courtesy note must never erase the operational record.
  try {
    const clientEmail = buildNewClientWaitlistClientEmail({
      studioName: studio.name,
      name: submission.name,
    });
    const clientSend = await sendWaitlistEmailIdempotent({
      namespace: "client",
      to: submission.email,
      subject: clientEmail.subject,
      html: clientEmail.html,
      text: clientEmail.text,
    });
    if (clientSend.status !== "accepted") {
      logWaitlistEvent("new_client_waitlist_client_email_not_accepted", {
        studioId: studio.id,
        status: clientSend.status,
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
