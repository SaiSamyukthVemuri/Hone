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

/** One row of the in-place chooser. Points at the EXISTING session route. */
export type ChartChoice = {
  sessionId: string;
  /** The existing session page. No new appointment-charts route exists. */
  href: string;
  /** Visible label from existing facts only, e.g. "Electrolysis · 2:04 PM". */
  label: string;
  /**
   * Accessible name. Carries the position — "Chart 1 of 2" — because two
   * sessions of one modality started in the same minute produce IDENTICAL
   * visible labels, and a screen reader would otherwise hear the same name
   * twice with no way to tell the links apart. Position is a fact about the
   * list, not invented clinical meaning: nothing here claims one chart is
   * newer-and-therefore-more-relevant, only which row is which.
   */
  accessibleName: string;
};

export type ChartResolution =
  | { kind: "none"; label: "Start charting"; href: string }
  | { kind: "one"; label: "Open chart"; href: string; sessionId: string }
  | {
      kind: "many";
      label: "View charts";
      /**
       * NO href. "View charts" expands a bounded chooser IN PLACE on the
       * dashboard card; it does not navigate. There is deliberately no
       * /clients/{id}/appointments/{id}/charts page — every destination in
       * `choices` is the session route that already exists.
       */
      choices: ReadonlyArray<ChartChoice>;
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

/** "electrolysis" -> "Electrolysis". Existing fact, presentation only. */
function modalityLabel(modality: string): string {
  if (modality.length === 0) return modality;
  return modality[0]!.toUpperCase() + modality.slice(1);
}

/**
 * Local clock time in the STUDIO's zone, e.g. "2:04 PM".
 *
 * The studio's zone, not the viewer's: a practitioner checking the roster while
 * travelling must read the times their day actually ran on. An unusable zone
 * would throw inside `Intl`, so it falls back to UTC rather than taking the
 * whole dashboard card down over a label.
 */
function startedTimeLabel(startedAt: string, timeZone: string): string {
  const at = new Date(startedAt);
  if (Number.isNaN(at.getTime())) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone,
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "UTC",
    }).format(at);
  }
}

/**
 * Decide the ONE chart action for an appointment from its live linked sessions.
 *
 * Callers pass every live session for THIS appointment. Order does not matter;
 * this sorts. Passing sessions belonging to another appointment is a caller
 * bug this cannot detect, which is why the grouping step must key strictly on
 * `appointment_id` equality.
 *
 * `timeZone` is the studio's IANA zone. It is REQUIRED, not defaulted: the
 * contract promises studio-local chooser labels, and a default silently
 * satisfies a promise it cannot keep. A forgotten argument would have rendered
 * UTC — "6:04 PM" against a 2:04 PM appointment reads as data, not as a bug,
 * which is the worst failure mode available. Omission is now a compile error.
 * An INVALID zone still falls back safely (see `startedTimeLabel`); absent and
 * invalid are deliberately no longer the same thing.
 */
export function resolveChartAction(
  clientId: string,
  appointmentId: string,
  liveSessions: ReadonlyArray<LinkedSession>,
  timeZone: string,
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
  // label that claims to have opened the chart. The chooser expands IN PLACE
  // and every row links to the session route that already exists — no new
  // appointment-charts page is introduced.
  //
  // Identical visible labels are ALLOWED and are not disambiguated by
  // inventing content: two electrolysis sessions started in the same minute
  // legitimately read the same. Order and links stay deterministic, and only
  // the accessible name carries position so the links remain distinguishable
  // to a screen reader.
  return {
    kind: "many",
    label: "View charts",
    choices: ordered.map((s, i) => {
      const label = `${modalityLabel(s.modality)} · ${startedTimeLabel(s.startedAt, timeZone)}`;
      return {
        sessionId: s.id,
        href: `${clientHref}/sessions/${s.id}`,
        label,
        accessibleName: `${label} — chart ${i + 1} of ${ordered.length}`,
      };
    }),
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
