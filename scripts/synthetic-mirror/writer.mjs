/**
 * scripts/synthetic-mirror/writer.mjs — synthetic row builders + reset selection.
 *
 * PURE ROW / PLAN BUILDER. It returns plain JavaScript objects describing the
 * population a reconciliation WOULD create, and decides which ids a reset WOULD
 * be allowed to remove. It opens no database client, issues no statement and
 * performs no I/O — which is what makes all of it unit-testable without a
 * database.
 *
 * NOTHING IN THIS CHANGE INSERTS THESE ROWS
 * -----------------------------------------
 * The objects below are a DESCRIPTION of intended state, not a write. No code
 * in this PR passes them to a database: `scripts/synthetic-mirror.mjs` performs
 * zero DML and reports that boundary explicitly (see `reportWriteBoundary()`
 * there). Executing them is a separately authorized layer that does not yet
 * exist.
 *
 * WHY DIRECT service_role DML WAS REJECTED
 * ----------------------------------------
 * Writing these rows directly from this repository was considered and
 * deliberately abandoned. It would breach two shipped guards, both of which
 * scan `scripts/` as well as `app/`, `lib/` and `components/`:
 *
 *   - `tests/security/entry-direct-dml-guard.test.ts` (L18 Phase 4) holds the
 *     direct-writer census for `sessions`, `session_blocks`,
 *     `session_block_areas`, `electrolysis_entries`, `laser_entries` and
 *     `treatment_images` at ZERO, with an exception list that is empty and
 *     documented as having no list left to append to;
 *   - `tests/security/appointment-direct-dml-guard.test.ts` freezes
 *     `appointments` at exactly seven reviewed writers, every one an UPDATE.
 *
 * service_role does still retain INSERT on these tables (verified in
 * production with has_table_privilege), and the governed alternatives are
 * genuinely unsuitable — `authenticated` INSERT was revoked by 0169/0172, and
 * the public booking command (0170) is reached through a server action that
 * SENDS A CONFIRMATION EMAIL. But "technically permitted and quieter" is not a
 * reason to become the one unreviewed clinical writer those guards exist to
 * prevent. Fixture convenience does not outrank the clinical-write boundary.
 *
 * A future executor therefore needs a GOVERNED path — a service_role-only RPC
 * added under an agreed migration number, or an out-of-repo operator process —
 * not an insert added here.
 *
 * Business invariants are respected rather than bypassed even though nothing is
 * written: appointments carry a consistent ends_at / duration_minutes /
 * buffer_minutes_snapshot / blocked_ends_at, and statuses come from the table's
 * own CHECK vocabulary, so the planned rows would be valid as-is.
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
 *
 * This is a SELECTION, not a deletion: nothing in this change removes a row.
 * `reset` reports these counts only. The contract a future governed executor
 * must honour is that it may act on `deletable` and on nothing else — which is
 * why `refused` is returned explicitly rather than silently dropped, and why
 * there is deliberately no code path anywhere in this tool that could issue
 * `delete ... where studio_id = ...`.
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
