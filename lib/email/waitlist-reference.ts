import { emailBookingReference } from "@/lib/email/booking-reference";

// Per-event subject reference for the waitlist family (the email subject sweep,
// tests/lib/email/email-subject-sweep.test.ts). Same derivation as the booking
// reference (a one-way digest, 6 unambiguous characters), namespaced so a
// waitlist id and an appointment id can never yield the same label.
//
// What is passed is always an opaque value: an invitation id, a durable
// waitlist entry id, or, on the transitional join path that has no durable
// event, the ALREADY-SALTED email fingerprint (lib/portal/tokens.ts
// hashFingerprint). Never a raw address: a short digest of a raw email could be
// confirmed by anyone holding a candidate address.
export function emailWaitlistReference(opaqueId: string): string {
  return emailBookingReference(`waitlist:${opaqueId}`);
}
