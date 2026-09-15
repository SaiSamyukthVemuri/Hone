// CHART-SESSION-01 / issue #699 — which chart does an appointment's CTA open?
//
// PURE. No I/O, no Supabase, no runtime wiring. Nothing here is reachable from
// a production surface yet, deliberately: `Start charting` must not become
// tappable until `start_session` is appointment-safe (finding 4008020858).
// This module exists so the DECISION can be specified and tested ahead of the
// database repair, not so the button can ship early.
//
// ---------------------------------------------------------------------------
// WHAT "LIVE" MEANS HERE, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
//
// A live session is: linked to THIS EXACT appointment, and `deleted_at is
// null`. That is the whole definition.
//
// It is NOT `record_status`. Migration 0159 PERMANENTLY RETIRED the
// signed/finalized clinical-record lifecycle and blocks any transition of
// `sessions.record_status` INTO 'finalized' or 'void'; every ordinary new
// session "is created 'draft' and stays 'draft'". Production holds exactly one
// non-draft session — a legacy artifact in a non-Willow controlled-test studio.
// Partitioning live-vs-completed on that column would therefore have sorted
// every real session into one bucket and left the other branch dead.
//
// It is NOT `appointments.status` either. A completed appointment does NOT make
// its chart read-only: treatment sessions remain editable operational records
// under Hone's current product model, so a completed appointment holding one
// linked session still resolves to "Open chart", exactly as a confirmed one
// does. Appointment status remains the appointment lifecycle authority and has
// no say over which chart a CTA opens.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A LIST AND NOT A MAP LOOKUP
// ---------------------------------------------------------------------------
//
// The dashboard built `sessionByAppointment` with
// `.set(appointment_id, session)` inside a loop over an unordered result set,
// so an appointment with several sessions silently kept whichever row the
// database happened to return last. That is not a product decision, it is an
// artifact of iteration order — and migration 0068 makes several sessions per
// appointment a LEGITIMATE shape, not an anomaly:
//
//   "One appointment may legitimately have zero or more session rows
//    (treatment-block split, multi-area work) ... The runtime invariant is
//    one-to-many in that direction, not one-to-one."
//
// Multi-modality is the everyday case: `sessions/new` offers electrolysis AND
// laser, and modality is part of the coalesce key, so one appointment holding
// one of each is ordinary. When there is genuinely more than one chart, this
// resolver refuses to pick. It says so and hands back every identity.

/** The minimum a caller must load per session for this decision. */
export type LinkedSession = {
  id: string;
  /** Session start. Not a total order on its own — see the tiebreak below. */
  startedAt: string;
  /** 'electrolysis' | 'laser'. Carried so a chooser can label its options. */
  modality: string;
};

export type ChartResolution =
  | { kind: "none"; label: "Start charting"; href: string }
  | { kind: "one"; label: "Open chart"; href: string; sessionId: string }
  | {
      kind: "many";
      label: "View charts";
      href: string;
      sessions: ReadonlyArray<LinkedSession>;
    };

/**
 * Deterministic newest-first order.
 *
 * `started_at` ALONE IS NOT A TOTAL ORDER. Two sessions can share a timestamp —
 * `start_session` stamps from the transaction clock, so two starts inside one
 * statement-timestamp tick collide — and equal keys leave the comparator free
 * to return either order. The chooser would then reshuffle between renders and
 * "the newest chart" would not be a stable claim. `id` breaks the tie, which is
 * the same correction the pinned-notes pagination needed for the same reason.
 */
function newestFirst(a: LinkedSession, b: LinkedSession): number {
  if (a.startedAt !== b.startedAt) return a.startedAt < b.startedAt ? 1 : -1;
  return a.id < b.id ? 1 : -1;
}

/**
 * Decide the ONE chart action for an appointment from its live linked sessions.
 *
 * Callers pass every live session for THIS appointment. Order does not matter;
 * this sorts. Passing sessions belonging to another appointment is a caller
 * bug this cannot detect, which is why the grouping step must key strictly on
 * `appointment_id` equality.
 */
export function resolveChartAction(
  clientId: string,
  appointmentId: string,
  liveSessions: ReadonlyArray<LinkedSession>,
): ChartResolution {
  const clientHref = `/clients/${clientId}`;

  // ZERO. Nothing charted for this appointment yet, so the action is to begin —
  // and this is the one branch that reaches `start_session`, which is why the
  // whole feature is gated on the database repair.
  if (liveSessions.length === 0) {
    return {
      kind: "none",
      label: "Start charting",
      href: `${clientHref}/sessions/new?appointment_id=${encodeURIComponent(appointmentId)}`,
    };
  }

  const ordered = [...liveSessions].sort(newestFirst);

  // EXACTLY ONE. Open that exact session BY ID. Never by re-running
  // `start_session` and hoping the coalesce window returns the same row:
  // an existing chart is opened, not re-derived, and the RPC is a
  // create-or-coalesce command rather than a lookup mechanism.
  if (ordered.length === 1) {
    const only = ordered[0]!;
    return {
      kind: "one",
      label: "Open chart",
      href: `${clientHref}/sessions/${only.id}`,
      sessionId: only.id,
    };
  }

  // MORE THAN ONE, ALL LEGITIMATE. Do not choose. Every one of these is a real
  // clinical record and picking "the newest" would hide the others behind a
  // label that claims to have opened the chart. The chooser carries the real
  // session identities; the ordering above only decides how they are listed.
  return {
    kind: "many",
    label: "View charts",
    href: `${clientHref}/appointments/${encodeURIComponent(appointmentId)}/charts`,
    sessions: ordered,
  };
}

/**
 * Group live sessions by appointment.
 *
 * REPLACES `sessionByAppointment.set(...)`. Every session is kept; nothing is
 * overwritten. Rows with a null `appointment_id` are dropped — an unlinked
 * session is not this appointment's chart, and inferring a link from
 * proximity is precisely the cross-appointment reuse that 4008020858 is.
 */
export function groupLiveSessionsByAppointment(
  rows: ReadonlyArray<LinkedSession & { appointmentId: string | null }>,
): Map<string, LinkedSession[]> {
  const out = new Map<string, LinkedSession[]>();
  for (const row of rows) {
    if (row.appointmentId === null) continue;
    const bucket = out.get(row.appointmentId);
    const session: LinkedSession = {
      id: row.id,
      startedAt: row.startedAt,
      modality: row.modality,
    };
    if (bucket) bucket.push(session);
    else out.set(row.appointmentId, [session]);
  }
  return out;
}
