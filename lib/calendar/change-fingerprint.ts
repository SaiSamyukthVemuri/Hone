// PURE. A fingerprint of what the calendar DRAWS from the database for one view, so a screen can tell whether it is stale
// without re-rendering. Server only (node:crypto); a client never computes it and never sees row contents, only the hash.
//
// What it covers, and why exactly these columns (HON-48, option B):
//   appointments        (id, updated_at)        updated_at is DATABASE-maintained (trigger, migration 0175), so every
//                                               update moves it; inserts take now(); no application delete path exists
//   timed blocks        (id, starts_at, ends_at, category, practitioner_id, updated_at)
//                                               updated_at is set by the application, so the displayed columns are
//                                               hashed too and no writer can leave a change unseen
//   blockouts           (id, starts_on, ends_on) inserted and deleted, never updated
//   break occurrences   (id, starts_at, ends_at) and the rule it belongs to (id, label, updated_at)
//
// It is a HASH OF ROWS, not max(updated_at) or a count: a transaction that started earlier but commits later carries an
// older now(), a count survives a delete plus an insert, and an application clock can run backwards. Any of those leaves
// max()+count unmoved; a hash over the rows moves for every one of them.
//
// What it deliberately does NOT cover (these stay on the slower 60 s cycle): client names, practitioner names and colours,
// service names, payment and settlement chips, studio settings. Booking conflict prevention is server-side and untouched.

import { createHash } from "node:crypto";

export type FingerprintAppointment = { id: string; updated_at: string | null };
export type FingerprintTimedBlock = {
  id: string;
  starts_at: string;
  ends_at: string;
  category: string;
  practitioner_id?: string | null;
  updated_at: string | null;
};
export type FingerprintBlockout = { id: string; starts_on: string; ends_on: string };
export type FingerprintOccurrence = {
  id: string;
  starts_at: string;
  ends_at: string;
  rule?: { id?: string | null; label?: string | null; updated_at?: string | null } | null;
};

export type FingerprintRows = {
  appointments: ReadonlyArray<FingerprintAppointment>;
  timedBlocks: ReadonlyArray<FingerprintTimedBlock>;
  blockouts: ReadonlyArray<FingerprintBlockout>;
  occurrences: ReadonlyArray<FingerprintOccurrence>;
};

/** Bump when the canonical form changes, so a mixed deployment can never compare two different encodings as equal. */
const FINGERPRINT_VERSION = "cf1";

function byId<T extends { id: string }>(rows: ReadonlyArray<T>): T[] {
  return [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export function calendarFingerprint(rows: FingerprintRows): string {
  const canonical = JSON.stringify([
    FINGERPRINT_VERSION,
    byId(rows.appointments).map((r) => [r.id, r.updated_at ?? null]),
    byId(rows.timedBlocks).map((r) => [r.id, r.starts_at, r.ends_at, r.category, r.practitioner_id ?? null, r.updated_at ?? null]),
    byId(rows.blockouts).map((r) => [r.id, r.starts_on, r.ends_on]),
    byId(rows.occurrences).map((r) => [
      r.id,
      r.starts_at,
      r.ends_at,
      r.rule ? [r.rule.id ?? null, r.rule.label ?? null, r.rule.updated_at ?? null] : null,
    ]),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
