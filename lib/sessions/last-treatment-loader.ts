import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  chartedSessionCandidates,
  groupBlocksBySession,
  pickNewestChartedSession,
  DEFAULT_CHARTED_SESSION_LIMIT,
  type ChartedSessionCandidate,
} from "@/lib/sessions/charted-session";
import type {
  PointOfCareBlock,
  PointOfCareEntry,
} from "@/lib/sessions/point-of-care-memory";
import type { PrepLaserEntry } from "@/lib/sessions/appointment-prep-memory";
import type { BlockArea } from "@/lib/sessions/block-areas";

// THE loader behind every "last treatment" surface changed by this PR.
//
// It costs exactly ONE round-trip, because the caller already has the client's
// sessions (and their live entries) in memory from getClientById — a read both
// the charting page and the new-session page already pay for. Only the prior
// settings blocks are missing, and they are fetched for the whole candidate
// window in a single batched `.in("session_id", …)`, never one query per
// session and never one per area.
//
// It is RLS-scoped: createClient() is the authenticated user client. There is
// no service-role client anywhere in this feature.
//
// It FAILS SOFT. A first-visit client, a client whose only other session is an
// abandoned empty one, and a failed blocks read all return null, and the caller
// renders nothing. A memory-panel failure must never take charting down.

// Everything the point-of-care card and the compact clinical summary need from
// a prior settings block, in one select. No entry columns: entries come from
// the sessions the caller already loaded.
export const BLOCK_COLUMNS =
  "id, session_id, sort_order, block_name, primary_area, side, custom_area_detail, " +
  "mode, apilus_modality, energy_level, minutes_performed, machine_frequency, " +
  "probe_label, probe_type, probe_size, probe_lot_number, probe_lot_confirmed, " +
  "numbing_status, numbing_notes, tolerance_rating, reaction_type, reaction_notes, " +
  "caution_for_next_session, caution_note, " +
  "structured_areas:session_block_areas(id, area, laterality, display_order, created_at)";

type RawArea = {
  id: string;
  area: string;
  laterality: BlockArea["laterality"];
  display_order: number | null;
  created_at: string | null;
};

type RawBlock = Omit<PointOfCareBlock, "structured_areas" | "entries"> & {
  session_id: string;
  deleted_at?: string | null;
  structured_areas?: RawArea[] | null;
};

// A session as getClientById returns it: entries embedded and already stripped
// of soft-deleted rows.
export type SessionWithLoadedEntries = ChartedSessionCandidate & {
  modality: string;
  next_session_note?: string | null;
  electrolysis_entries?: ReadonlyArray<
    PointOfCareEntry & { block_id?: string | null }
  > | null;
};

export type LastChartedTreatment<T extends SessionWithLoadedEntries> = {
  session: T;
  blocks: PointOfCareBlock[];
  // True when a NEWER candidate session exists that carries no charting at
  // all — the exact situation that used to hide this treatment.
  supersededByEmptySession: boolean;
  // The newest candidate carrying a next-visit note, WHICH MAY NOT BE THE
  // SELECTED TREATMENT.
  //
  // The plan source is deliberately decoupled from the last-treatment source,
  // because a plan can be written on a session that never got charted — and the
  // note most likely to change what happens today is the most RECENT one, not
  // the one attached to the last visit that produced blocks. PR #203 made this
  // exact decoupling on the client Overview and the dashboard preview after
  // Chloe reported the failure; `pickPreClientWatchPlanSource`
  // (lib/sessions/clinical-summary.ts) is the pure form of the same rule.
  //
  // Concretely: an abandoned row carrying "Client started doxycycline, do not
  // treat" must not be silenced by an older charted visit that happens to say
  // "start lower on the sideburn".
  //
  // Free — every candidate already carries next_session_note.
  newestPlan: { sessionId: string; startedAt: string; text: string } | null;
};

// Deterministic child-row order, matching session_block_areas_block_order_idx:
// (display_order, created_at, id). PostgREST does not order embedded rows
// reliably, so the order is established here.
function orderAreas(rows: ReadonlyArray<RawArea>): BlockArea[] {
  return [...rows]
    .sort((a, b) => {
      const ao = a.display_order ?? 0;
      const bo = b.display_order ?? 0;
      if (ao !== bo) return ao - bo;
      const ac = a.created_at ?? "";
      const bc = b.created_at ?? "";
      if (ac !== bc) return ac < bc ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((r) => ({ area: r.area, laterality: r.laterality }));
}


// The newest candidate carrying a next-visit note. Candidates are already
// newest-first, already time-bounded and already appointment-filtered, so the
// first hit is the answer. Charted-ness is deliberately NOT required.
function newestPlanOf<T extends SessionWithLoadedEntries>(
  candidates: ReadonlyArray<T>,
): { sessionId: string; startedAt: string; text: string } | null {
  for (const c of candidates) {
    const text = c.next_session_note?.trim();
    if (text) {
      return { sessionId: c.id, startedAt: c.started_at, text };
    }
  }
  return null;
}

export async function loadLastChartedTreatment<
  T extends SessionWithLoadedEntries,
>(input: {
  studioId: string;
  // The client's sessions, as already loaded by getClientById.
  sessions: ReadonlyArray<T>;
  // Strict upper bound on started_at (the current session's start, when
  // charting). Omit on the new-session page, where no session exists yet.
  before?: string | null;
  excludeSessionId?: string | null;
  limit?: number;
}): Promise<LastChartedTreatment<T> | null> {
  const candidates = chartedSessionCandidates(input.sessions, {
    before: input.before,
    excludeSessionId: input.excludeSessionId,
    limit: input.limit,
  });
  return selectFromCandidates(input.studioId, candidates);
}

// The half of the loader that runs AFTER the candidate window is known: one
// batched block read, THE shared selector, and the assembly of the returned
// shape. Factored out so the appointment-prep companion below reuses it
// verbatim rather than restating any part of it.
async function selectFromCandidates<T extends SessionWithLoadedEntries>(
  studioId: string,
  candidates: ReadonlyArray<T>,
): Promise<LastChartedTreatment<T> | null> {
  if (candidates.length === 0) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select(BLOCK_COLUMNS)
    // RLS already scopes to the caller's studio; the explicit filter is
    // defence-in-depth so a foreign session id could never surface a block.
    .eq("studio_id", studioId)
    .in(
      "session_id",
      candidates.map((s) => s.id),
    )
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });

  if (error) {
    // CLASSIFICATION ONLY. Observable enough to operate, carrying nothing a log
    // aggregator should not hold.
    //
    // `error.message` is a raw PostgREST/Postgres string. It routinely echoes
    // the failing statement, and this query's statement embeds candidate
    // SESSION IDS and every clinical column name in the select — so a single
    // failed read could put a client's treatment structure into the log
    // pipeline. The SQLSTATE alone answers the only operational question that
    // matters (permission vs. schema vs. timeout), and the studio id and
    // candidate count answer "how big and whose".
    //
    // Never logged: the raw message, the client id, treatment areas, note
    // excerpts, entry values, or any part of the query payload.
    console.error(
      JSON.stringify({
        event: "last_charted_treatment_blocks_read_failed",
        // SQLSTATE, e.g. "42501" (insufficient privilege) or "PGRST200".
        code: typeof error.code === "string" ? error.code : null,
        studio_id: studioId,
        candidate_count: candidates.length,
        at: new Date().toISOString(),
      }),
    );
    return null;
  }

  const rows = (data ?? []) as unknown as RawBlock[];
  const bySession = groupBlocksBySession(rows);
  // THE selector, not a second copy of its rule. `candidates` is already the
  // filtered, ordered, bounded window, so this only applies the content half —
  // but routing it through pickNewestChartedSession is what guarantees the
  // charting page, the new-session panel and the unit/DB tests can never drift
  // apart on what "the last treatment" means.
  const selected = pickNewestChartedSession(candidates, bySession);
  if (!selected) return null;

  // Live electrolysis passes for the selected session, grouped by block. The
  // caller's sessions were already stripped of soft-deleted entries; the
  // deleted_at guard below keeps this correct for a caller that was not.
  const entriesByBlock = new Map<string, PointOfCareEntry[]>();
  for (const entry of selected.electrolysis_entries ?? []) {
    if (entry.deleted_at != null) continue;
    const blockId = entry.block_id;
    if (!blockId) continue;
    const bucket = entriesByBlock.get(blockId);
    if (bucket) bucket.push(entry);
    else entriesByBlock.set(blockId, [entry]);
  }

  const blocks: PointOfCareBlock[] = (bySession.get(selected.id) ?? []).map(
    (b) => ({
      ...b,
      structured_areas: orderAreas(b.structured_areas ?? []),
      entries: entriesByBlock.get(b.id) ?? [],
    }),
  );

  return {
    session: selected,
    blocks,
    supersededByEmptySession: candidates[0]?.id !== selected.id,
    newestPlan: newestPlanOf(candidates),
  };
}

// ---------------------------------------------------------------------------
// APPOINTMENT-PREP COMPANION
// ---------------------------------------------------------------------------
//
// loadLastChartedTreatment above requires the caller to ALREADY hold the
// client's sessions with their live entries — true on the charting screen and
// on /sessions/new, because both pay for getClientById anyway. The calendar
// appointment-detail page does not: it is appointment-scoped and deliberately
// reads eight client columns, not the whole profile.
//
// So it used to run its own newest-non-deleted-ROW query
// (`order started_at desc limit 1`) and inspect only that row — which is the
// exact defect charted-session.ts exists to eliminate: an abandoned empty
// session, or a newer administrative row, permanently won the lookup and
// rendered an empty "Last session" over a real treatment sitting one row below.
//
// This companion closes that without importing getClientById (unbounded: every
// session the client ever had, `*, electrolysis_entries(*), laser_entries(*)`,
// plus pricing, plus the whole client row, plus the studio's practitioners —
// four round-trips and a materially wider PII surface on an appointment route).
// It performs ONE bounded candidate read and then delegates to exactly the same
// selector and the same batched block read the other two surfaces use. It does
// NOT restate what "charted" means.
//
// Cost: TWO round-trips, independent of history length, block count, area count
// and pass count. The page it replaces spent three (newest row → that row's
// blocks → attachStructuredAreas).

// The candidate read's columns.
//
// KNOWN TRADE-OFF, stated rather than hidden: the entry columns are consumed in
// full only for the SELECTED session. For the other candidates in the window the
// single field read is `deleted_at` (liveCount, for the charted test), yet the
// embed materialises every entry of all of them. For a two-year weekly client
// that is on the order of hundreds of pass rows per appointment-page render.
// The remedy, if this ever shows up in practice, is to narrow the embeds to
// `electrolysis_entries(deleted_at), laser_entries(deleted_at)` and re-fetch the
// selected session's entries in a third round-trip — a payload win paid for with
// a wave. It is left at two waves deliberately; see the per-column
// justification in tests/lib/sessions/appointment-prep-memory.test.ts.
//
//   * id / started_at / record_status / deleted_at → ChartedSessionCandidate.
//   * modality            → the laser discriminator in blocklessTreatmentCopy.
//   * session_notes       → the prior visit's general narrative.
//   * next_session_note   → "For next visit".
//   * appointment_id      → so THIS appointment's own linked session can never
//                           be presented as its own previous treatment.
//   * electrolysis_entries: deleted_at + block_id + created_at are structural
//     (live-count, block grouping, canonical-pass selection); `area` labels a
//     pre-0019 pass that carries NO block_id, whose narrative reaches no block
//     and would otherwise be invisible; the readings are
//     the PointOfCareEntry surface; `comments` is the live "Additional notes"
//     narrative. galvanic_intensity_percent is DELIBERATELY absent — a retired
//     input is never read.
//   * laser_entries: deleted_at proves a laser visit is charted; zone +
//     observation_notes carry the only narrative a laser visit has.
export const PREP_ENTRY_COLUMNS =
  "id, block_id, area, created_at, deleted_at, mode, hairs_treated, observation_chips, " +
  "comments, thermolysis_intensity_percent, thermolysis_duration_seconds, " +
  "galvanic_ma, galvanic_duration_seconds, units_of_lye, pulse_count, " +
  "pulse_delay_seconds";

export const PREP_SESSION_COLUMNS =
  "id, started_at, modality, record_status, deleted_at, appointment_id, " +
  "session_notes, next_session_note, " +
  `electrolysis_entries(${PREP_ENTRY_COLUMNS}), ` +
  "laser_entries(id, deleted_at, zone, observation_notes)";

// The session shape this companion returns. A superset of
// SessionWithLoadedEntries, so it satisfies the shared selector unchanged.
export type AppointmentPrepSession = SessionWithLoadedEntries & {
  session_notes?: string | null;
  appointment_id?: string | null;
  laser_entries?: ReadonlyArray<PrepLaserEntry> | null;
};

// "No prior treatment" and "the read failed" are CLINICALLY DIFFERENT answers,
// and the appointment page renders a sentence for the first one. Collapsing
// both into null made a transient timeout on a forty-visit client read as a
// confident "No previous treatment charted for this client." — which the code
// this replaced could never do, because it threw instead.
export type AppointmentPrepLoad = {
  treatment: LastChartedTreatment<AppointmentPrepSession> | null;
  // True ONLY when a read actually failed. A first-visit client, and a client
  // whose only other sessions carry no charting, both leave this false.
  unavailable: boolean;
};

export async function loadLastChartedTreatmentForClient(input: {
  studioId: string;
  clientId: string;
  // Strict upper bound on started_at — the appointment's starts_at. A session
  // that began at or after this appointment is not "last treatment BEFORE this
  // appointment".
  before?: string | null;
  // This appointment's id. Every session linked to it is the CURRENT visit
  // record, never the prior treatment. Passed as an id rather than resolved
  // from the page's linked-session query so the exclusion holds even when more
  // than one session carries the FK (no unique constraint exists on it).
  excludeAppointmentId?: string | null;
  excludeSessionId?: string | null;
  limit?: number;
}): Promise<AppointmentPrepLoad> {
  const limit = Math.max(1, input.limit ?? DEFAULT_CHARTED_SESSION_LIMIT);
  const supabase = await createClient();

  // THE SQL HALF, exactly as charted-session.ts specifies it (studio, client,
  // soft-delete, newest-first), plus two bounds that must be pushed down rather
  // than left to the pure filter:
  //
  //   * `before` — WITHOUT it the LIMIT window is spent on sessions that start
  //     after this appointment (a client with 25 future bookings already charted
  //     would push the real prior treatment out of the window entirely). This is
  //     a CORRECTNESS requirement, not an optimisation. The pure selector still
  //     re-applies the same bound.
  //   * `limit` — the window is bounded in SQL so an unbounded client history
  //     can never turn into an unbounded IN(...) list in the block read.
  let query = supabase
    .from("sessions")
    .select(PREP_SESSION_COLUMNS)
    .eq("studio_id", input.studioId)
    .eq("client_id", input.clientId)
    .is("deleted_at", null);
  if (input.before) query = query.lt("started_at", input.before);
  const { data, error } = await query
    .order("started_at", { ascending: false })
    .limit(limit);

  if (error) {
    // CLASSIFICATION ONLY — same contract as the block read above. A raw
    // PostgREST message echoes the failing statement, and this statement names
    // every clinical column in the select plus the client id filter.
    console.error(
      JSON.stringify({
        event: "appointment_prep_sessions_read_failed",
        code: typeof error.code === "string" ? error.code : null,
        studio_id: input.studioId,
        candidate_count: 0,
        at: new Date().toISOString(),
      }),
    );
    return { treatment: null, unavailable: true };
  }

  const rows = (data ?? []) as unknown as AppointmentPrepSession[];

  // THE CONTENT HALF — the same shared selector, with the appointment boundary
  // expressed through its own option rather than restated here.
  const candidates = chartedSessionCandidates(rows, {
    before: input.before,
    excludeSessionId: input.excludeSessionId,
    excludeAppointmentId: input.excludeAppointmentId,
    limit,
  });
  // The block read fails soft to null as well. Distinguishing THAT failure from
  // "nothing charted" would need the shared selector to change shape, so it is
  // deliberately reported as absence — the candidate read is where a permission
  // or timeout failure actually shows up first.
  const treatment = await selectFromCandidates(input.studioId, candidates);
  return { treatment, unavailable: false };
}
