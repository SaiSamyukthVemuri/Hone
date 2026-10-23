import { createHash } from "node:crypto";

// THREADING (Codex P1 4354990813 on #1049). Gmail and Outlook thread mail on
// the normalized subject and participants, so once the client, service and
// time left the practitioner's "New booking at <studio>" subject (#828), every
// booking for one studio collapsed into one thread and buried the newest. The
// magic-link fix (PR #127) reworded its subject once, which suits a message
// whose newest copy supersedes the rest. Bookings are distinct events, so each
// subject carries its own short reference instead.
//
// The reference is DERIVED, not stored: a one-way digest of the appointment
// id, cut to 6 characters of an unambiguous alphabet. It names no client,
// service or time, cannot be reversed to the id, and is the same on every
// render of one booking, so a retry stays in its own thread. It is a label,
// not a credential: nothing accepts it as input.
//
// Codex rounds 1-3 on #1049 found this one template at a time. The decision
// for EVERY email is now made in one place: tests/lib/email/email-subject-sweep.test.ts.

const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/1/I/L/O
const LENGTH = 6;

function reference(namespace: string, id: string): string {
  const digest = createHash("sha256").update(`${namespace}:${id}`, "utf8").digest();
  let out = "";
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[digest[i] % ALPHABET.length];
  return out;
}

/** Per-booking reference: every appointment-bound email (tests/lib/email/email-subject-sweep.test.ts). */
export function emailBookingReference(appointmentId: string): string {
  return reference("hone-booking-ref", appointmentId);
}

/** Per-intake-form reference: each reissue creates a new intake row. */
export function emailIntakeReference(intakeId: string): string {
  return reference("hone-intake-ref", intakeId);
}
