import { emailBookingReference } from "@/lib/email/booking-reference";
import type { WaitlistSubmission } from "@/lib/booking/new-client-waitlist";
import { hashFingerprint } from "@/lib/portal/tokens";

// Per-event subject reference for the waitlist family (the email subject sweep,
// tests/lib/email/email-subject-sweep.test.ts). Same derivation as the booking
// reference (a one-way digest, 6 unambiguous characters), namespaced so a
// waitlist id and an appointment id can never yield the same label.
//
// What is passed is always an opaque value: an invitation id, a durable
// waitlist entry id, or, on the transitional join path that has no durable
// event, an ALREADY-SALTED digest of the whole submission (lib/portal/tokens.ts
// hashFingerprint; see waitlistJoinReference in app/book/[slug]/waitlist-actions.ts).
// Never a raw address or raw submission: a short digest of one could be
// confirmed by anyone holding a candidate value.
export function emailWaitlistReference(opaqueId: string): string {
  return emailBookingReference(`waitlist:${opaqueId}`);
}

/**
 * The per-join subject reference.
 *
 * DURABLE path: the entry id, one per join event.
 *
 * NOTIFICATION-COMMIT bridge: there is no durable event, and the provider key
 * is a digest of the payload, so two accepted submissions are two emails
 * exactly when their payloads differ. The reference follows the same thing: a
 * SALTED digest (hashFingerprint) of the WHOLE validated submission the payload
 * carries (name, email, phone), never the email alone (Codex P2 4355538066 on
 * #1051: a different name or phone from one address otherwise shared a
 * subject). An identical retry is one request, so it keeps one reference. The
 * JSON array keeps the encoding injective, so no value can shift into another
 * field.
 *
 * NULL when production has no salt: the bare subject is a recorded
 * degradation; an unsalted digest of the submission is never used.
 */
export function waitlistJoinReference(entryId: string | null, submission: WaitlistSubmission): string | null {
  if (entryId) return emailWaitlistReference(`join:${entryId}`);
  const fingerprint = hashFingerprint(
    JSON.stringify(["waitlist-join", submission.name, submission.email, submission.phone]),
  );
  return fingerprint ? emailWaitlistReference(`join-sub:${fingerprint}`) : null;
}
