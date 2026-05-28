import { randomBytes } from "crypto";

// High-entropy opaque bearer token used in cancellation and reschedule URLs
// (confirmation + reminder emails). Stored in appointments.cancellation_token.
// 24 random bytes (32 url-safe base64 chars) make enumeration impractical.
//
// Possession of a valid token is the only credential required (clients
// clicking from email don't log in); it authorizes cancel/reschedule while
// the appointment is still eligible. Replay AFTER a successful
// cancel/reschedule is blocked by the appointment status transitions, the
// SELECT ... FOR UPDATE row locks in the mutation RPCs, and reschedule token
// rotation — so there is intentionally no explicit single-use (used_at /
// token-uses) schema; mutation replay is handled by the appointment state
// machine.
//
// The public token-route actions (cancel / reschedule / intake) apply rate
// limiting via lib/rate-limit/public.ts (that file is the single source of
// truth for limiter behavior).
//
// Note: first use by whoever holds a forwarded/leaked but still-eligible link
// is an inherent bearer-link property that token entropy and rate limiting do
// not address; reducing it would require a shorter token TTL or step-up
// verification, addressed separately if product/security requires it.
export function generateAppointmentToken(): string {
  return randomBytes(24)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
