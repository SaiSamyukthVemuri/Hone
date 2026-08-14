import { createHash, randomBytes } from "crypto";

// High-entropy opaque bearer token used in cancellation and reschedule URLs
// (confirmation + reminder emails). Stored hashed at rest in
// appointments.cancellation_token_hash (PR #260); the raw token lives only in
// transit (the URL). The legacy raw appointments.cancellation_token column
// was dropped in PR #264 (migration 0091). 24 random bytes (32 url-safe
// base64 chars) make enumeration impractical.
//
// Possession of a valid token is the only credential required (clients
// clicking from email don't log in); it authorizes cancel/reschedule while
// the appointment is still eligible. Replay AFTER a successful
// cancel/reschedule is blocked by the appointment status transitions, the
// SELECT ... FOR UPDATE row locks in the mutation RPCs, and reschedule token
// rotation, so there is intentionally no explicit single-use (used_at /
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

// PR #260: SHA-256 hex digest of a raw appointment token. This is the
// only token value persisted at rest (appointments.cancellation_token
// _hash); the raw token lives only in transit (the /cancel, /reschedule,
// /manage URL) and, for surfaces that rebuild a link after creation, is
// replaced by the stateless HMAC token (lib/booking/tokens.ts). A DB
// compromise therefore yields no usable bearer tokens. Mirrors the
// portal (lib/portal/tokens.ts) and calendar-feed (lib/calendar-feed/
// token.ts) hash-at-rest helpers; the migration 0090 CHECK enforces the
// same 64-lowercase-hex shape. trim() is intentionally NOT applied: the
// URL path segment is the canonical source, matching the old raw lookup.
export function hashAppointmentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
