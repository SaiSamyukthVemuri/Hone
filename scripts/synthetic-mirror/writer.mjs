/**
 * scripts/synthetic-mirror/writer.mjs — synthetic row builders + reset selection.
 *
 * PURE. Builds the exact row objects the CLI inserts, and decides exactly which
 * ids reset may delete. Kept separate from the CLI so all of it is unit-testable
 * without a database.
 *
 * WRITE PATH — why direct service_role INSERT rather than a governed command
 * -------------------------------------------------------------------------
 * The brief prefers governed write paths. Here they are both unavailable and
 * unsafe:
 *   - `authenticated` has had INSERT on appointments / sessions /
 *     client_intake_forms revoked (0169, 0172), so there is no authenticated
 *     path left to use;
 *   - the governed PUBLIC command (`0170_public_appointment_command`) is reached
 *     through the booking server action, which SENDS A CONFIRMATION EMAIL and
 *     writes an audit row attributed to a client actor. Using it to mint
 *     fixtures would be both noisier and less safe.
 * service_role retains INSERT on all four tables (verified against production
 * with has_table_privilege). A direct insert touches no notification path, so
 * it is the quiet option as well as the only available one.
 *
 * Business invariants are still respected rather than bypassed: appointments
 * carry a consistent ends_at / duration_minutes / buffer_minutes_snapshot /
 * blocked_ends_at, and statuses come from the table's own CHECK vocabulary.
 */

import { deriveSyntheticId } from "./identity.mjs";
import { SAFE_NOTES, cohortForOrdinal, generateClients } from "./generator.mjs";

const MINUTE_MS = 60_000;

/** Deterministic pick from a list. */
function pick(list, n) {
  return list[n % list.length];
}

/**
 * Build all synthetic client rows for a plan.
 * Only ordinals in [from, to] are produced, so a re-run adds only what is new.
 */
export function buildClientRows(studioId, fromOrdinal, toOrdinal) {
  const all = generateClients(studioId, toOrdinal + 1);
  return all.slice(fromOrdinal, toOrdinal + 1);
}

/**
 * Build synthetic appointment rows.
 *
 * `anchorMs` is passed in (never read from a clock here) so the builder stays
 * pure and the tests are deterministic. Statuses are painted from the plan's
 * mix in a fixed order, so the same plan always yields the same distribution.
 */
export function buildAppointmentRows(opts) {
  const {
    studioId,
    clientIds,
    practitionerId,
    serviceIds,
    mix,
    fromOrdinal,
    count,
    anchorMs,
  } = opts;
  if (clientIds.length === 0 || count <= 0) return [];

  // Expand the mix into a deterministic status sequence.
  const sequence = [];
  for (const status of ["confirmed", "completed", "cancelled", "no_show"]) {
    for (let i = 0; i < (mix[status] ?? 0); i += 1) sequence.push(status);
  }
  if (sequence.length === 0) return [];

  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const ordinal = fromOrdinal + i;
    const status = sequence[ordinal % sequence.length];
    const durations = [30, 45, 60, 90];
    const duration = pick(durations, ordinal);
    const bufferMinutes = 15;

    // Confirmed appointments go into the future; every other status is history.
    // The 8-day floor keeps synthetic bookings clear of the 7d/3d intake-reminder
    // and 24h/2h reminder windows — belt and braces on top of the NULL email.
    const dayOffset =
      status === "confirmed" ? 8 + (ordinal % 45) : -(3 + (ordinal % 240));
    const hour = 9 + (ordinal % 8);
    const start = new Date(anchorMs + dayOffset * 24 * 60 * MINUTE_MS);
    start.setUTCHours(hour, (ordinal % 2) * 30, 0, 0);
    const startMs = start.getTime();
    const endMs = startMs + duration * MINUTE_MS;

    rows.push({
      id: deriveSyntheticId(studioId, "appointment", ordinal),
      studio_id: studioId,
      client_id: pick(clientIds, ordinal),
      practitioner_id: practitionerId,
      service_id: serviceIds.length > 0 ? pick(serviceIds, ordinal) : null,
      starts_at: new Date(startMs).toISOString(),
      ends_at: new Date(endMs).toISOString(),
      duration_minutes: duration,
      buffer_minutes_snapshot: bufferMinutes,
      blocked_ends_at: new Date(endMs + bufferMinutes * MINUTE_MS).toISOString(),
      status,
      notes: SAFE_NOTES.session,
      cancelled_at:
        status === "cancelled" ? new Date(startMs - 2 * 24 * 60 * MINUTE_MS).toISOString() : null,
      cancelled_by: status === "cancelled" ? "client" : null,
      cancellation_reason: null,
    });
  }
  return rows;
}

/** Build synthetic session rows (the charting surface). */
export function buildSessionRows(opts) {
  const { studioId, clientIds, practitionerId, mix, fromOrdinal, count, anchorMs } = opts;
  if (clientIds.length === 0 || count <= 0) return [];

  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const ordinal = fromOrdinal + i;
    // Paint the two gap dimensions independently, matching the source's ratios.
    const missingAftercare = ordinal % Math.max(1, count) < mix.missingAftercare;
    const withNextNote = (ordinal * 7) % Math.max(1, count) < mix.withNextNote;
    const startedAt = new Date(anchorMs - (2 + (ordinal % 300)) * 24 * 60 * MINUTE_MS);

    rows.push({
      id: deriveSyntheticId(studioId, "session", ordinal),
      studio_id: studioId,
      client_id: pick(clientIds, ordinal),
      practitioner_id: practitionerId,
      modality: ordinal % 5 === 0 ? "laser" : "electrolysis",
      started_at: startedAt.toISOString(),
      ended_at: new Date(startedAt.getTime() + 45 * MINUTE_MS).toISOString(),
      session_notes: ordinal % 3 === 0 ? SAFE_NOTES.tolerated : SAFE_NOTES.session,
      next_session_note: withNextNote ? SAFE_NOTES.plan : null,
      aftercare_and_risks_explained_at: missingAftercare
        ? null
        : new Date(startedAt.getTime() + 50 * MINUTE_MS).toISOString(),
    });
  }
  return rows;
}

/** Build synthetic intake rows. */
export function buildIntakeRows(opts) {
  const { studioId, clientIds, mix, fromOrdinal, count } = opts;
  if (clientIds.length === 0 || count <= 0) return [];

  const sequence = [];
  for (const status of ["in_progress", "submitted", "reviewed"]) {
    for (let i = 0; i < (mix[status] ?? 0); i += 1) sequence.push(status);
  }
  if (sequence.length === 0) return [];

  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const ordinal = fromOrdinal + i;
    rows.push({
      id: deriveSyntheticId(studioId, "intake", ordinal),
      studio_id: studioId,
      client_id: pick(clientIds, ordinal),
      status: sequence[ordinal % sequence.length],
    });
  }
  return rows;
}

/**
 * RESET SELECTION (Phase 13).
 *
 * Given the ids actually present in the target for one entity, return only
 * those that are PROVABLY synthetic, plus the ones that must be left alone.
 * The caller deletes `deletable` and nothing else — there is deliberately no
 * code path that issues `delete ... where studio_id = ...`.
 */
export function selectResettableIds(presentIds, derivableSet) {
  const deletable = [];
  const refused = [];
  for (const id of presentIds) {
    if (derivableSet.has(id)) deletable.push(id);
    else refused.push(id);
  }
  return { deletable, refused };
}

/** Cohort label for an ordinal, re-exported so the dry-run can summarise. */
export { cohortForOrdinal };
