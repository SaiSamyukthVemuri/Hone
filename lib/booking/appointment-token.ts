import { randomBytes } from "crypto";

// Random opaque token used in cancellation and reschedule URLs sent in
// confirmation + reminder emails. Stored in appointments.cancellation_token.
// The token itself is the only auth required: clients clicking from email
// don't have to log in. Defense in depth: server actions verify the token
// is for an appointment that's still cancellable/reschedulable, and the
// token's 24 random bytes (32 url-safe base64 chars) make enumeration
// impractical.
//
// Rate limiting: the public BOOKING surfaces (slot fetch + booking submit)
// are rate-limited when Upstash is configured (lib/rate-limit/public.ts,
// fail-open). Rate limiting of the token routes themselves (cancel /
// reschedule / intake) is deferred to a later phase; today they rely on
// token entropy + the per-action state checks above.
export function generateAppointmentToken(): string {
  return randomBytes(24)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
