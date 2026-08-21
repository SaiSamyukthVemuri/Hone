import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  CHARTED_COUNT_COLUMNS,
  hasCautionFromCounts,
  hasLiveBlocksFromCounts,
  isChartedFromCounts,
  liveBlockCount,
  liveEntryCount,
  liveLaserCount,
  type ChartedEvidenceRow,
} from "@/lib/sessions/history/evidence";
import {
  applySessionRecencyOrder,
  isStrictlyBeforeCanonical,
} from "@/lib/sessions/history/recency";
import {
  newestWhere,
  observedWhere,
  unsafeCreateHistoricalWindow,
  type HistoricalAnswer,
  type HistoricalWindow,
} from "@/lib/sessions/history/window";

// THE SELECTION AUTHORITY — which visit was the previous one, and nothing else.
//
// It owns, in one place, every rule that used to be spread across a page's own
// query, a pure picker and a caller's array:
//
//   * the appointment-specific cutoff, at database precision;
//   * the own-session and own-appointment exclusions;
//   * the canonical TOTAL recency order, emitted into SQL;
//   * read errors, classified rather than discarded;
//   * partial and unknown evidence, kept distinct from absence;
//   * same-client multiple appointments, separated INSIDE the authority.
//
// Consumers ask it questions. They never receive rows to rank, so they cannot
// re-answer "which of these is the newest?" for themselves — which is what made
// every previous version of this boundary advisory.
//
// NOTE ON THE PROJECTION LAW. The session read below selects `*` plus the count
// aggregates, so this module contains NO column list at all. Between it and
// lib/sessions/history/visit-detail.ts, the entire historical authority names
// zero clinical columns, and adding a treatment field requires editing neither.

/**
 * Rows fetched per client before the read is considered exhausted.
 *
 * Matches `DEFAULT_CHARTED_SESSION_LIMIT`, the window the product already
 * considers deep enough to find a prior treatment. Crossing it does not corrupt
 * a RECENCY answer — the rows lost are a suffix of the oldest — it only makes
 * ABSENCE unprovable, which is exactly what `indeterminate` records.
 */
export const HISTORY_ROWS_PER_CLIENT = 25;

export type HistorySession = ChartedEvidenceRow & {
  id: string;
  client_id: string;
  started_at: string;
  modality?: string | null;
  record_status?: string | null;
  deleted_at?: string | null;
  appointment_id?: string | null;
  session_notes?: string | null;
  next_session_note?: string | null;
  price_paid_cents?: number | null;
  practitioner_id?: string | null;
  performed_by_practitioner_id?: string | null;
  aftercare_and_risks_explained_at?: string | null;
};

export type HistoryRequest = {
  /** How the caller will look this answer up. Usually the appointment id. */
  requestKey: string;
  clientId: string;
  /**
   * Exclusive upper bound — the appointment's `starts_at`.
   *
   * `null` means the surface genuinely has no appointment horizon (the client
   * profile asks "what did we last do for this client"). It is never a clock
   * read: a surface without a horizon must not invent one.
   */
  before: string | null;
  /**
   * The appointment being prepared. Every session carrying this id is the
   * CURRENT visit record, not the visit before it.
   *
   * Strictly stronger than excluding a single session id: `appointment_id` has
   * no unique constraint (migration 0068), so excluding only the row a
   * `limit(1)` lookup happened to return would leave a sibling behind.
   */
  excludeAppointmentId?: string | null;
  /** The session being charted right now. Never its own previous treatment. */
  excludeSessionId?: string | null;
};

/**
 * One client's prior visits, as questions rather than rows.
 *
 * Constructed only by `loadClientHistories`. There is no public constructor that
 * takes an array, because that is the shape a caller can re-rank.
 */
export class ClientHistory {
  private constructor(
    private readonly window: HistoricalWindow<HistorySession> | null,
    private readonly failed: boolean,
  ) {}

  static forWindow(window: HistoricalWindow<HistorySession>): ClientHistory {
    return new ClientHistory(window, false);
  }

  /** The read did not happen. Every question answers `failed`. */
  static forFailure(): ClientHistory {
    return new ClientHistory(null, true);
  }

  /** The newest prior visit that actually CONTAINS charting. */
  latestChartedVisit(): HistoricalAnswer<HistorySession> {
    if (this.failed) return { kind: "failed" };
    return newestWhere(this.window!, (row) => isChartedFromCounts(row));
  }

  /**
   * The newest prior visit carrying at least one live settings block — the only
   * kind of visit on which a setup can have been recorded.
   *
   * A RECENCY claim ("Latest setup"), so it is conjunctive: an undecidable newer
   * visit poisons it rather than letting an older setup be presented as current.
   */
  latestVisitWithSetup(): HistoricalAnswer<HistorySession> {
    if (this.failed) return { kind: "failed" };
    return newestWhere(this.window!, (row) => hasLiveBlocksFromCounts(row));
  }

  /** The newest prior visit carrying a "for next visit" note. */
  latestPlanNote(): HistoricalAnswer<HistorySession> {
    if (this.failed) return { kind: "failed" };
    return newestWhere(this.window!, (row) =>
      Boolean(row.next_session_note?.trim()),
    );
  }

  /**
   * A visit that recorded a caution.
   *
   * A BARE POSITIVE question, and deliberately NOT conjunctive. The product rule
   * in lib/sessions/clinical-summary.ts is that "a newer charted session WITHOUT
   * notes no longer hides the previous session's still-relevant guidance", and
   * the rendered line says "Caution: <text>", which claims nothing about
   * recency. Making it conjunctive would delete a recorded clinical caution
   * because a DIFFERENT visit's count did not arrive.
   */
  observedCaution(): HistoricalAnswer<HistorySession> {
    if (this.failed) return { kind: "failed" };
    return observedWhere(this.window!, (row) => hasCautionFromCounts(row) === true);
  }

  /** The visit carrying watch/plan guidance — a caution, a plan note, or both. */
  watchPlanSource(): HistoricalAnswer<HistorySession> {
    if (this.failed) return { kind: "failed" };
    return observedWhere(
      this.window!,
      (row) =>
        hasCautionFromCounts(row) === true || Boolean(row.next_session_note?.trim()),
    );
  }

  /** A visit carrying legacy narrative. A bare positive fact. */
  observedLegacyNotes(): HistoricalAnswer<HistorySession> {
    if (this.failed) return { kind: "failed" };
    return observedWhere(this.window!, (row) => Boolean(row.session_notes?.trim()));
  }

  /**
   * Is there a NEWER prior visit than the selected one that carries no charting?
   *
   * The sentence this licenses — "Most recent charted treatment. A newer session
   * has no treatment details yet." — is itself a recency assertion, so it is
   * answered here rather than by a caller comparing `rows[0]`. It is sound
   * because the window is the top-N under a TOTAL order, so its first row really
   * is the newest, and because "uncharted" comes from a COUNT rather than from a
   * missing map entry.
   *
   * Conservative by construction: an undecidable newer row yields FALSE, so the
   * claim is withheld rather than guessed.
   */
  supersededByUnchartedVisit(selected: HistorySession): boolean {
    if (this.failed || !this.window) return false;
    for (const row of this.window.rows) {
      if (row.id === selected.id) return false;
      if (isChartedFromCounts(row) === false) return true;
    }
    return false;
  }

  /** How many live blocks the database says this visit has. Null when unread. */
  expectedLiveBlocks(session: HistorySession): number | null {
    return liveBlockCount(session);
  }

  /** Live pass counts, from the row's own aggregates rather than from rows. */
  liveEntryCount(session: HistorySession): number | null {
    return liveEntryCount(session);
  }

  liveLaserCount(session: HistorySession): number | null {
    return liveLaserCount(session);
  }
}

/**
 * The loosest cutoff in a batch, so ONE read can serve every request.
 *
 * `null` anywhere means at least one surface has no horizon at all, and the read
 * must not apply one.
 */
function loosestBefore(requests: ReadonlyArray<HistoryRequest>): string | null {
  let loosest: string | null = null;
  for (const r of requests) {
    if (r.before === null) return null;
    if (loosest === null) {
      loosest = r.before;
      continue;
    }
    if (isStrictlyBeforeCanonical(loosest, r.before) === true) loosest = r.before;
  }
  return loosest;
}

/**
 * Read every request's history in ONE round-trip.
 *
 * The read is batched across clients and bounded per client; the PARTITIONING —
 * each appointment's own cutoff, its own exclusions, its own client — happens
 * inside this function, so a caller with two bookings for the same client on one
 * day gets two horizons and two answers, and never a client-wide array to
 * re-filter.
 */
export async function loadClientHistories(input: {
  studioId: string;
  requests: ReadonlyArray<HistoryRequest>;
}): Promise<Map<string, ClientHistory>> {
  const out = new Map<string, ClientHistory>();
  const requests = input.requests;
  if (requests.length === 0) return out;

  const clientIds = [...new Set(requests.map((r) => r.clientId))].filter(Boolean);
  if (clientIds.length === 0) return out;

  // Budget per client, plus ONE row: an exactly-full response is
  // indistinguishable from a truncated one, so asking for one more is how
  // exhaustion is observed without a second query.
  const budget = HISTORY_ROWS_PER_CLIENT * clientIds.length;
  const before = loosestBefore(requests);

  const supabase = await createClient();
  const { data, error } = await applySessionRecencyOrder(
    supabase
      // `*` plus the count aggregates: no column list in this module at all.
      .from("sessions")
      .select(`*, ${CHARTED_COUNT_COLUMNS}`)
      .eq("studio_id", input.studioId)
      .in("client_id", clientIds)
      .is("deleted_at", null)
      // The live filter must reach each COUNT; without it a visit whose only
      // block was soft-deleted reads as charted.
      .is("live_block_count.deleted_at", null)
      .is("live_entry_count.deleted_at", null)
      .is("live_laser_count.deleted_at", null)
      .is("caution_count.deleted_at", null)
      .or("caution_for_next_session.is.true,caution_note.not.is.null", {
        referencedTable: "caution_count",
      })
      .lt("started_at", before ?? "infinity"),
  ).limit(budget + 1);

  if (error) {
    // CLASSIFICATION ONLY: a raw PostgREST message echoes the statement, which
    // names the client ids.
    console.error(
      JSON.stringify({
        event: "client_history_read_failed",
        code: typeof error.code === "string" ? error.code : null,
        studio_id: input.studioId,
        client_count: clientIds.length,
        at: new Date().toISOString(),
      }),
    );
    for (const r of requests) out.set(r.requestKey, ClientHistory.forFailure());
    return out;
  }

  const all = (data ?? []) as unknown as HistorySession[];
  const exhausted = all.length > budget;
  const rows = exhausted ? all.slice(0, budget) : all;

  for (const request of requests) {
    // Per-request narrowing, INSIDE the authority. `filter` preserves the
    // canonical order, so no re-sort is needed and none happens.
    const mine = rows.filter((row) => {
      if (row.client_id !== request.clientId) return false;
      if (row.record_status === "void") return false;
      if (
        request.excludeAppointmentId &&
        row.appointment_id === request.excludeAppointmentId
      ) {
        return false;
      }
      if (request.excludeSessionId && row.id === request.excludeSessionId) return false;
      // A surface with no horizon keeps every prior row.
      if (request.before === null) return true;
      // Compared at DATABASE precision. `new Date().getTime()` would collapse two
      // instants under a millisecond apart and admit a visit this appointment's
      // boundary excludes. An UNPARSEABLE instant is unknown, and an unknown row
      // is refused rather than admitted.
      return isStrictlyBeforeCanonical(row.started_at, request.before) === true;
    });

    out.set(
      request.requestKey,
      ClientHistory.forWindow(
        unsafeCreateHistoricalWindow(
          mine,
          exhausted
            ? { kind: "exhausted", returned: all.length, limit: budget }
            : { kind: "complete" },
        ),
      ),
    );
  }

  return out;
}
