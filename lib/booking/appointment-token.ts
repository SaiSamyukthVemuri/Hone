import { randomBytes } from "crypto";

// Random opaque token used in cancellation and reschedule URLs sent in
// confirmation + reminder emails. Stored in appointments.cancellation_token.
// The token itself is the only auth required: clients clicking from email
// don't have to log in. Defense in depth: server actions verify the token
// is for an appointment that's still cancellable/reschedulable, and the
// public pages are rate-limited.
//
// 24 random bytes = 32 url-safe base64 chars after encoding. Plenty of
// entropy to make enumeration impractical.
export function generateAppointmentToken(): string {
  return randomBytes(24)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
