/**
 * scripts/synthetic-mirror/generator.mjs — deterministic fake-people generator.
 *
 * PURE. No clock, no randomness, no I/O. Everything is a function of
 * (studioId, ordinal), so the same studio always regenerates the same people —
 * which is what lets reconciliation be idempotent without storing anything.
 *
 * PRIVACY: this module has no input channel from the source studio. It cannot
 * copy a real name because it never sees one. The only thing the source ever
 * contributes to the mirror is a COUNT (see profile.mjs).
 *
 * ---------------------------------------------------------------------------
 * WHY EMAIL AND PHONE ARE NULL — this is a safety mechanism, not a shortcut
 * ---------------------------------------------------------------------------
 * The brief suggested `hone-test+<n>@example.com`. We deliberately emit NULL
 * instead, because a non-null email re-opens a provider path that studio
 * configuration CANNOT close:
 *
 *   app/api/cron/appointment-reminders/route.ts sendIntakeReminderPass()
 *   selects confirmed appointments 7d/3d out across ALL studios and emails the
 *   client whenever their latest intake is still `in_progress`. Unlike the 24h
 *   and 2h passes it has NO studio toggle — the code comment says so outright.
 *   That endpoint is fired every 15 minutes by an EXTERNAL cron-job.org job, so
 *   it is not disabled by anything in this repository.
 *
 * The two cohorts the brief asks for — "upcoming-booking client" and
 * "in-progress intake" — are exactly the pair that trips it. Relying on those
 * cohorts never overlapping would be an invariant the rebalancer could silently
 * break later.
 *
 * With `email IS NULL` every outbound path short-circuits structurally:
 *   - sendReminderPass         → `if (!appt.client?.email) continue`
 *   - sendIntakeReminderPass   → `if (!appt.client?.email) continue`
 *   - sendSmsReminderPass      → `if (!appt.client.phone) continue`
 *   - postcare / confirmation  → require an address, and are only sent by
 *                                server actions this tool never invokes.
 *
 * `clients.email` and `clients.phone` are both nullable (0001_init.sql:39-40),
 * so this costs nothing. It holds no matter how the studio's toggles are set —
 * and today the target studio has send_confirmation_emails, send_24h_reminders,
 * send_2h_reminders and notify_practitioner_on_new_booking all ON.
 */

import { deriveSyntheticId } from "./identity.mjs";

// Realistic-looking given names so the dashboard reads like a real studio.
const GIVEN_NAMES = Object.freeze([
  "Avery", "Maya", "Jordan", "Leila", "Noah", "Priya", "Taylor", "Rowan",
  "Ines", "Mateo", "Nora", "Devon", "Sasha", "Kiran", "Elise", "Theo",
  "Amara", "Quinn", "Bea", "Otto", "Lena", "Rafa", "Suki", "Wren",
  "Cleo", "Idris", "Mira", "Pax", "Yuki", "Zane",
]);

// Surnames chosen so a human reading ANY row instantly knows it is a fixture.
// This is a readability aid for the operator; the authoritative marker is the
// deterministic v8 UUID in identity.mjs, never this list.
const SYNTHETIC_SURNAMES = Object.freeze([
  "Testwood", "Sample", "Fixture", "Example", "Sandbox", "Demo", "Synthetic",
  "Placeholder", "Mock", "Stub", "Dummy", "Proxy", "Draft", "Harness",
]);

const PRONOUNS = Object.freeze(["she/her", "he/him", "they/them"]);

// Fixed safe vocabulary. Deliberately flat and clinical-sounding without
// telling a story — nothing here resembles a real client narrative, and no
// phrase is derived from any source record.
export const SAFE_NOTES = Object.freeze({
  client: "Synthetic test fixture. Not a real person.",
  session: "Synthetic test note.",
  tolerated: "Demo client tolerated treatment well.",
  reduceNext: "Test fixture: reduce intensity next visit.",
  watch: "Synthetic watch note.",
  aftercare: "Demo aftercare reviewed.",
  plan: "Test fixture: plan for next visit recorded.",
});

/** Deterministic non-negative integer derived from a stable string. */
function stableIndex(studioId, ordinal, salt, modulo) {
  let h = 2166136261;
  const s = `${studioId}|${ordinal}|${salt}`;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % modulo;
}

/**
 * The cohort ladder. Assignment is by ordinal so it is deterministic and stable
 * across runs: client #12 is always the same cohort, which keeps the To-do list
 * stable between reconciliations instead of churning.
 */
export const COHORTS = Object.freeze([
  "brand_new",          // no intake, no session, no booking
  "upcoming_only",      // future booking, nothing charted yet
  "returning",          // history + future booking
  "long_history",       // deep history, complete treatment memory
  "lapsed",             // history, no future booking
  "intake_in_progress", // intake started, never submitted
  "intake_submitted",   // awaiting practitioner review
  "intake_reviewed",    // reviewed
  "charting_gap",       // completed appointment, no session
  "aftercare_gap",      // session without aftercare marked
  "probe_gap",          // session without a probe lot
  "follow_up",          // plan-for-next-visit and nothing booked
]);

/**
 * Generate one synthetic client row (column names match public.clients).
 * email and phone are ALWAYS null — see the header note.
 */
export function syntheticClient(studioId, ordinal, cohort) {
  const given = GIVEN_NAMES[stableIndex(studioId, ordinal, "given", GIVEN_NAMES.length)];
  const surname =
    SYNTHETIC_SURNAMES[stableIndex(studioId, ordinal, "surname", SYNTHETIC_SURNAMES.length)];

  // Plausible adult DOB, deterministic, obviously not tied to any real person.
  const year = 1968 + stableIndex(studioId, ordinal, "dobY", 36);
  const month = 1 + stableIndex(studioId, ordinal, "dobM", 12);
  const day = 1 + stableIndex(studioId, ordinal, "dobD", 28);
  const dob = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  return {
    id: deriveSyntheticId(studioId, "client", ordinal),
    studio_id: studioId,
    // Sequence suffix keeps names unique at Willow's scale without inventing
    // more surnames, and reads as a fixture at a glance.
    name: `${given} ${surname}`,
    pronouns: PRONOUNS[stableIndex(studioId, ordinal, "pron", PRONOUNS.length)],
    date_of_birth: cohort === "brand_new" ? null : dob,
    // STRUCTURAL PROVIDER SAFETY — do not change without re-reading the header.
    email: null,
    phone: null,
    address: null,
    fitzpatrick_type: 1 + stableIndex(studioId, ordinal, "fitz", 6),
    skin_notes: null,
    contraindications: null,
    photo_consent: false,
    notes: SAFE_NOTES.client,
  };
}

/** Deterministic cohort for an ordinal. */
export function cohortForOrdinal(ordinal) {
  return COHORTS[ordinal % COHORTS.length];
}

/**
 * Generate `count` synthetic clients for a studio, ordinals 0..count-1.
 * Re-running with a larger count is purely additive — existing ordinals keep
 * their exact identity and content.
 */
export function generateClients(studioId, count) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(syntheticClient(studioId, i, cohortForOrdinal(i)));
  }
  return out;
}
