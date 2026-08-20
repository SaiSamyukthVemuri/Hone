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
import type {
  PrepLaserEntry,
  PrepNarrativeItem,
} from "@/lib/sessions/appointment-prep-memory";
import type { BlockArea } from "@/lib/sessions/block-areas";
import {
  buildPreVisitBriefing,
  type BeforeToday,
} from "@/lib/sessions/before-today";
import {
  buildLastSessionSummary,
  pickPreClientWatchPlanSource,
  type ClinicalSummaryBlock,
} from "@/lib/sessions/clinical-summary";
import { buildTreatmentIntelligence } from "@/lib/sessions/treatment-intelligence";

// THE loader behind every "last treatment" surface changed by this PR.
//
// It costs exactly ONE round-trip, because the caller already has the client's
// sessions (and their live entries) in memory from getClientById, a read both
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
// Hard ceiling on the batched candidate read, so a studio with a very large
// day can never ask PostgREST for an unbounded payload. Crossing it is not
// silent: see the truncation contract on loadLastChartedTreatmentsForClients.
const MAX_BATCH_CANDIDATE_ROWS = 600;

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
  // all: the exact situation that used to hide this treatment.
  supersededByEmptySession: boolean;
};

// PrepNarrativeItem is defined in the pure module and re-exported here for
// callers that already import from the loader. Deliberately NOT part of
// LastChartedTreatment: narrative can exist when no treatment does, and nesting
// it inside the treatment made it structurally impossible to return in exactly
// that case.
export type { PrepNarrativeItem };

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
): PrepNarrativeItem | null {
  for (const c of candidates) {
    const text = c.next_session_note?.trim();
    if (text) {
      return { sessionId: c.id, startedAt: c.started_at, text };
    }
  }
  return null;
}

// The legacy `sessions.session_notes` of the NEWEST eligible prior row.
//
// Deliberately the newest row and not a scan: before this feature the
// appointment page selected the newest non-deleted session before the
// appointment and rendered THAT row's session_notes. Preserving the same rule
// is what keeps a note the product previously displayed from silently
// disappearing: sessions.session_notes has no surviving writer, so the text on
// existing rows can never be recreated.
//
// THE INVARIANT, stated accurately: this reads the newest row of the CANDIDATE
// window, which is stricter than the old `limit 1` query: void rows and this
// appointment's own sessions are excluded before it is applied.
//
// That is NOT the same as "can never surface something the old page would have
// hidden", which an earlier version of this comment claimed and which is false:
// when the newest RAW row is void (or belongs to this appointment), the old page
// showed its notes or nothing, whereas this falls through to the next eligible
// candidate and may show an OLDER row's notes instead. That fall-through is the
// intended behaviour (an excluded row must not speak) and it is exactly why
// every fallback item carries its own date rather than being read as belonging
// to whatever treatment is displayed above it.
function newestLegacyNotesOf<T extends SessionWithLoadedEntries>(
  candidates: ReadonlyArray<T>,
): PrepNarrativeItem | null {
  const newest = candidates[0];
  if (!newest) return null;
  const text = (newest as { session_notes?: string | null }).session_notes?.trim();
  if (!text) return null;
  return { sessionId: newest.id, startedAt: newest.started_at, text };
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
  // The charting screen and /sessions/new keep their existing FAIL-SOFT
  // contract: they render nothing when there is nothing to render, and a
  // memory panel must never take those pages down. Only the appointment-prep
  // companion, whose surface makes an explicit statement to the practitioner,
  // needs to tell "none" and "unavailable" apart, so the distinction is not
  // forced on unrelated callers.
  const outcome = await selectFromCandidates(input.studioId, candidates);
  return outcome.status === "selected" ? outcome.treatment : null;
}

// Why this is a discriminated union and not `| null`.
//
// Three outcomes are CLINICALLY different and were previously collapsed into
// one `null`: a successful read that found a treatment, a successful read that
// found none, and a read that FAILED. A caller cannot tell the last two apart
// from a null, so the appointment page rendered "No previous treatment charted
// for this client." (an affirmative clinical denial) whenever the block read
// errored. Never infer failure from an absent value.
type SelectOutcome<T extends SessionWithLoadedEntries> =
  | { status: "selected"; treatment: LastChartedTreatment<T> }
  // The reads succeeded; this client genuinely has no charted prior treatment.
  | { status: "none" }
  // The batched block read failed. We know nothing about whether a treatment
  // exists, and must never claim one does not.
  | { status: "unavailable" };

// The half of the loader that runs AFTER the candidate window is known: one
// batched block read, THE shared selector, and the assembly of the returned
// shape. Factored out so the appointment-prep companion below reuses it
// verbatim rather than restating any part of it.
async function selectFromCandidates<T extends SessionWithLoadedEntries>(
  studioId: string,
  candidates: ReadonlyArray<T>,
): Promise<SelectOutcome<T>> {
  if (candidates.length === 0) return { status: "none" };

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
    // SESSION IDS and every clinical column name in the select, so a single
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
    return { status: "unavailable" };
  }

  const rows = (data ?? []) as unknown as RawBlock[];
  const bySession = groupBlocksBySession(rows);
  // THE selector, not a second copy of its rule. `candidates` is already the
  // filtered, ordered, bounded window, so this only applies the content half,
  // but routing it through pickNewestChartedSession is what guarantees the
  // charting page, the new-session panel and the unit/DB tests can never drift
  // apart on what "the last treatment" means.
  const selected = pickNewestChartedSession(candidates, bySession);
  // A SUCCESSFUL read that found nothing charted. Distinct from the failure
  // above, and the distinction is the whole point of this type.
  if (!selected) return { status: "none" };

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
    status: "selected",
    treatment: {
      session: selected,
      blocks,
      supersededByEmptySession: candidates[0]?.id !== selected.id,
    },
  };
}

// ---------------------------------------------------------------------------
// APPOINTMENT-PREP COMPANION
// ---------------------------------------------------------------------------
//
// loadLastChartedTreatment above requires the caller to ALREADY hold the
// client's sessions with their live entries: true on the charting screen and
// on /sessions/new, because both pay for getClientById anyway. The calendar
// appointment-detail page does not: it is appointment-scoped and deliberately
// reads eight client columns, not the whole profile.
//
// So it used to run its own newest-non-deleted-ROW query
// (`order started_at desc limit 1`) and inspect only that row, which is the
// exact defect charted-session.ts exists to eliminate: an abandoned empty
// session, or a newer administrative row, permanently won the lookup and
// rendered an empty "Last session" over a real treatment sitting one row below.
//
// This companion closes that without importing getClientById (unbounded: every
// session the client ever had, `*, electrolysis_entries(*), laser_entries(*)`,
// plus pricing, plus the whole client row, plus the studio's practitioners,
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
// selected session's entries in a third round-trip, a payload win paid for with
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
//     narrative. galvanic_intensity_percent is DELIBERATELY absent: a retired
//     input is never read.
//   * laser_entries: deleted_at proves a laser visit is charted; zone +
//     observation_notes carry the only narrative a laser visit has.
export const PREP_ENTRY_COLUMNS =
  "id, block_id, area, created_at, deleted_at, mode, hairs_treated, observation_chips, " +
  "comments, thermolysis_intensity_percent, thermolysis_duration_seconds, " +
  "galvanic_ma, galvanic_duration_seconds, units_of_lye, pulse_count, " +
  "pulse_delay_seconds";

export const PREP_SESSION_COLUMNS =
  // `client_id` is selected only so the BATCHED companion can route each row
  // back to its client. It is not part of the prep model and no surface reads
  // it. Harmless for the single-client path, which already filters on it.
  "id, client_id, started_at, modality, record_status, deleted_at, appointment_id, " +
  // Consumed by the "Aftercare/risks not marked" reminder rule. One
  // timestamptz per candidate row; no extra query.
  "aftercare_and_risks_explained_at, " +
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
// confident "No previous treatment charted for this client.", which the code
// this replaced could never do, because it threw instead.
export type AppointmentPrepLoad = {
  /**
   * The full pre-visit briefing — Remember, Caution, Latest setup and the
   * missing-record reminders — derived from THIS APPOINTMENT'S bounded window.
   *
   * Null only when the caller supplied no `client` fields, i.e. did not ask
   * for a briefing. It is deliberately populated even when no charted
   * treatment was found, because a note-only prior visit still has something
   * to say; `hasHistory` inside it remains the honest answer to "is there a
   * charted treatment".
   *
   * This is what lets one bounded pipeline serve every selected day. The
   * client-scoped, unbounded preview loader it replaces could not express an
   * appointment boundary at all.
   */
  briefing: BeforeToday | null;
  treatment: LastChartedTreatment<AppointmentPrepSession> | null;
  // True ONLY when a read actually failed: the candidate read OR the batched
  // block read. A first-visit client, and a client whose only other sessions
  // carry no charting, both leave this false.
  unavailable: boolean;
  // Practitioner narrative recovered from the CANDIDATE WINDOW, independent of
  // whether a charted treatment was selected.
  //
  // WHY IT IS SEPARATE FROM `treatment`
  // -----------------------------------
  // A plan can be written on a visit that never got charted. `start_session`
  // (0167) creates a row the instant a modality is tapped, and
  // `set_next_session_note` (0167) has no charting gate, so a
  // consultation-only or abandoned visit can legitimately carry
  // "Client started doxycycline, do not treat" with zero blocks and zero
  // entries. While this lived inside LastChartedTreatment it was structurally
  // unreachable in exactly that case, and the page said there was nothing to
  // know. The note-only row is still NOT a treatment: the shared charted
  // definition is untouched: it simply has narrative worth showing.
  //
  // Also survives a FAILED block read: the candidate rows were already fetched
  // successfully, so their narrative is known even when treatment detail is not.
  //
  // Free: every candidate already carries both columns.
  narrative: {
    // newestPlanOf, the one plan authority, charted-ness not required.
    plan: PrepNarrativeItem | null;
    // The newest eligible row's legacy session_notes, matching what the
    // pre-Session-1D page rendered.
    legacySessionNotes: PrepNarrativeItem | null;
  };
};

export async function loadLastChartedTreatmentForClient(input: {
  studioId: string;
  clientId: string;
  // Strict upper bound on started_at, the appointment's starts_at. A session
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
  //   * `before`, WITHOUT it the LIMIT window is spent on sessions that start
  //     after this appointment (a client with 25 future bookings already charted
  //     would push the real prior treatment out of the window entirely). This is
  //     a CORRECTNESS requirement, not an optimisation. The pure selector still
  //     re-applies the same bound.
  //   * `limit`, the window is bounded in SQL so an unbounded client history
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
    // CLASSIFICATION ONLY: same contract as the block read above. A raw
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
    // The candidate read itself failed, so nothing (not even narrative) was
    // successfully loaded.
    return {
      treatment: null,
      unavailable: true,
      narrative: { plan: null, legacySessionNotes: null },
      // The single-client path predates the briefing and does not build one.
      briefing: null,
    };
  }

  const rows = (data ?? []) as unknown as AppointmentPrepSession[];

  // THE CONTENT HALF: the same shared selector, with the appointment boundary
  // expressed through its own option rather than restated here.
  const candidates = chartedSessionCandidates(rows, {
    before: input.before,
    excludeSessionId: input.excludeSessionId,
    excludeAppointmentId: input.excludeAppointmentId,
    limit,
  });
  // Narrative is resolved from the candidate rows we already hold, BEFORE and
  // independently of the block read. That is what lets it survive both "nothing
  // is charted" and "the block read failed".
  const narrative = {
    plan: newestPlanOf(candidates),
    legacySessionNotes: newestLegacyNotesOf(candidates),
  };

  const outcome = await selectFromCandidates(input.studioId, candidates);
  switch (outcome.status) {
    // `briefing: null` throughout: the single-client path serves the
    // appointment detail page, which renders the full card and does not ask
    // for the row-sized briefing. Only the batched Dashboard caller does.
    case "selected":
      return {
        treatment: outcome.treatment,
        unavailable: false,
        narrative,
        briefing: null,
      };
    case "none":
      // Reads succeeded; this client genuinely has no charted prior treatment.
      // Narrative may still exist and must still be shown.
      return {
        treatment: null,
        unavailable: false,
        narrative,
        briefing: null,
      };
    case "unavailable":
      // The block read failed. Say so, and keep the narrative that WAS loaded,
      // discarding it would hide a safety instruction we already have in hand.
      return {
        treatment: null,
        unavailable: true,
        narrative,
        briefing: null,
      };
  }
}

// ---------------------------------------------------------------------------
// BATCHED COMPANION: many clients, a CONSTANT number of round-trips.
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS. `loadLastChartedTreatmentForClient` above is per-client and
// costs two waves. The dashboard renders every appointment of the day at once,
// so calling it per appointment would be a textbook N+1: twenty appointments,
// forty round-trips, growing with the studio's day.
//
// WHAT IT IS NOT. It is NOT a second treatment-memory model. It performs the
// I/O in bulk and then delegates, unchanged, to exactly the same pure pieces
// the appointment page uses: `chartedSessionCandidates`, `pickNewestChartedSession`,
// `groupBlocksBySession`, `orderAreas`, `newestPlanOf`, `newestLegacyNotesOf`,
// and returns the same `AppointmentPrepLoad` shape, so the caller can hand the
// result straight to `buildAppointmentPrepMemory`. If the definition of "the
// last charted treatment" ever changes, it changes in one place and this
// follows, because none of that rule is restated here.
//
// COST. Two waves total, independent of how many appointments the day holds:
// one bounded candidate read across every client, then one block read across
// every candidate session. Same shape as `getBeforeTodayPreviews`.
//
// THE PER-CLIENT BOUND. Each appointment has its own `before` (its own
// starts_at), but SQL gets only the LOOSEST of them: the exclusive upper bound
// is pushed down once so the window is not spent on far-future rows, and the
// exact per-client bound is re-applied by `chartedSessionCandidates`, which
// already takes `before` and is the same code the single-client path relies on
// for that. Narrowing in SQL per client is what would force a query per client.
//
// TRUNCATION IS REPORTED, NOT GUESSED. One `.in(...)` read shares a single row
// budget between clients, so a client with a long history can crowd out a
// quieter one. If that happened, a client with no candidates has NOT been shown
// to have no treatment: we simply did not read far enough. Those clients come
// back `unavailable: true`, which the card already renders as "couldn't load"
// rather than as "new client". Presenting a forty-visit client as a first visit
// is the exact failure the charted-session authority exists to prevent, and it
// must not be reintroduced by a batching optimisation.

export type PrepMemoryRequest = {
  /**
   * The caller's identity for THIS request, and the key of the returned map.
   *
   * Required, and deliberately not defaulted to `clientId`. A client can have
   * two appointments in one day, and each carries its own `before` and its own
   * exclusion, so the ANSWER differs per appointment even though the client is
   * the same. Keying anything by clientId makes the second request silently
   * overwrite the first and hands both appointments one answer. The dashboard
   * passes the appointment id.
   */
  requestKey: string;
  clientId: string;
  /** Exclusive upper bound on started_at, this appointment's starts_at. */
  before?: string | null;
  /** This appointment's id; sessions linked to it are the CURRENT visit. */
  excludeAppointmentId?: string | null;
  /**
   * Client-record fields for the missing-record reminders.
   *
   * Passed IN rather than read here on purpose: they are client facts, not
   * history, and the Dashboard already has them on the roster query's own
   * client embed — so supplying them costs no round-trip. Omit them and the
   * three client-record rules simply do not run, which is why the briefing is
   * only produced when they are present.
   */
  client?: {
    dateOfBirth: string | null;
    phone: string | null;
    address: string | null;
  } | null;
};

export async function loadLastChartedTreatmentsForClients(input: {
  studioId: string;
  requests: ReadonlyArray<PrepMemoryRequest>;
  /** Candidate window per client. Defaults to the shared charted-session limit. */
  limitPerClient?: number;
  /** Keyed by `requestKey`, NOT by clientId. See PrepMemoryRequest. */
}): Promise<Map<string, AppointmentPrepLoad>> {
  const out = new Map<string, AppointmentPrepLoad>();
  const requests = input.requests.filter((r) => Boolean(r.clientId) && Boolean(r.requestKey));
  if (requests.length === 0) return out;

  const perClient = Math.max(1, input.limitPerClient ?? DEFAULT_CHARTED_SESSION_LIMIT);
  const clientIds = [...new Set(requests.map((r) => r.clientId))];
  // Named separately so the redaction guard never sees an identifier-shaped
  // token inside a log payload.
  const clientCount = clientIds.length;

  // The loosest bound across the batch. `undefined` only when no request set
  // one, in which case no upper bound is pushed down at all.
  const bounds = requests.map((r) => r.before).filter((b): b is string => Boolean(b));
  const loosestBefore =
    bounds.length === requests.length && bounds.length > 0
      ? bounds.reduce((a, b) => (a > b ? a : b))
      : null;

  // Budget the single read so each client could, in the even case, fill its own
  // window. Capped so a large day cannot ask for an unbounded payload.
  const budget = Math.min(perClient * clientIds.length, MAX_BATCH_CANDIDATE_ROWS);

  const supabase = await createClient();
  let query = supabase
    .from("sessions")
    .select(PREP_SESSION_COLUMNS)
    .eq("studio_id", input.studioId)
    .in("client_id", clientIds)
    .is("deleted_at", null);
  if (loosestBefore) query = query.lt("started_at", loosestBefore);
  const { data, error } = await query
    .order("started_at", { ascending: false })
    .limit(budget);

  if (error) {
    // CLASSIFICATION ONLY, same contract as the single-client path: never the
    // raw message (it echoes the statement, which names every clinical column
    // and the client ids), never a client id, never any clinical value.
    console.error(
      JSON.stringify({
        event: "appointment_prep_sessions_batch_read_failed",
        code: typeof error.code === "string" ? error.code : null,
        studio_id: input.studioId,
        client_count: clientCount,
        at: new Date().toISOString(),
      }),
    );
    for (const r of requests) {
      out.set(r.requestKey, {
        treatment: null,
        unavailable: true,
        narrative: { plan: null, legacySessionNotes: null },
        briefing: null,
      });
    }
    return out;
  }

  const rows = (data ?? []) as unknown as AppointmentPrepSession[];
  const truncated = rows.length >= budget;

  // Partition by client. `client_id` is selected below purely to route rows;
  // it is not part of the prep model.
  const byClient = new Map<string, AppointmentPrepSession[]>();
  for (const row of rows) {
    const cid = (row as { client_id?: string | null }).client_id;
    if (!cid) continue;
    const bucket = byClient.get(cid);
    if (bucket) bucket.push(row);
    else byClient.set(cid, [row]);
  }

  // THE SHARED SELECTOR, applied ONCE PER REQUEST, not once per client.
  //
  // Two requests can name the same client and still deserve different answers,
  // because `before` and `excludeAppointmentId` belong to the APPOINTMENT.
  // Keying this map by clientId let the second request overwrite the first, so
  // a client with a morning and an afternoon booking saw one memory on both
  // rows. Pure, no I/O in this loop.
  const candidatesByRequest = new Map<string, AppointmentPrepSession[]>();
  for (const r of requests) {
    candidatesByRequest.set(
      r.requestKey,
      chartedSessionCandidates(byClient.get(r.clientId) ?? [], {
        before: r.before,
        excludeAppointmentId: r.excludeAppointmentId,
        limit: perClient,
      }),
    );
  }

  // ONE block read for the UNION of every request's candidates. Two requests
  // over the same client overlap heavily; the Set collapses them, so per-request
  // evaluation never becomes a per-request query.
  const allCandidateIds = [
    ...new Set([...candidatesByRequest.values()].flat().map((c) => c.id)),
  ];
  let blocksBySession = new Map<string, RawBlock[]>();
  let blocksUnavailable = false;
  if (allCandidateIds.length > 0) {
    const { data: blockData, error: blockError } = await supabase
      .from("session_blocks")
      .select(BLOCK_COLUMNS)
      // RLS already scopes to the caller's studio; explicit for defence in depth.
      .eq("studio_id", input.studioId)
      .in("session_id", allCandidateIds)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true });
    if (blockError) {
      console.error(
        JSON.stringify({
          event: "appointment_prep_blocks_batch_read_failed",
          code: typeof blockError.code === "string" ? blockError.code : null,
          studio_id: input.studioId,
          candidate_count: allCandidateIds.length,
          at: new Date().toISOString(),
        }),
      );
      blocksUnavailable = true;
    } else {
      blocksBySession = groupBlocksBySession(
        (blockData ?? []) as unknown as RawBlock[],
      );
    }
  }

  // Chips for EVERY candidate block, not just the selected session's. The
  // watch/plan source and the treatment intelligence both read blocks from
  // across the window, and the unified reaction line needs each block's own
  // live observation chips. The entries are already loaded — this is a loop,
  // not a query.
  const entriesByBlockAll = new Map<string, PointOfCareEntry[]>();
  for (const row of rows) {
    for (const entry of row.electrolysis_entries ?? []) {
      if (entry.deleted_at != null) continue;
      const blockId = entry.block_id;
      if (!blockId) continue;
      const bucket = entriesByBlockAll.get(blockId);
      if (bucket) bucket.push(entry);
      else entriesByBlockAll.set(blockId, [entry]);
    }
  }

  /**
   * The pre-visit briefing for ONE appointment, from ITS OWN bounded window.
   *
   * Every fact is evaluated over `candidates`, which the charted-session
   * authority has already filtered by this appointment's `before`, its own
   * session exclusion, soft-deletes and void records. That is the whole point:
   * the same helpers the client Overview uses, fed a window that knows which
   * appointment it is preparing for.
   */
  function briefingFor(
    r: PrepMemoryRequest,
    candidates: AppointmentPrepSession[],
    selected: AppointmentPrepSession | null,
  ): BeforeToday | null {
    if (!r.client) return null;
    const blocksOf = (sessionId: string) => blocksBySession.get(sessionId) ?? [];
    // BLOCK_COLUMNS selects every field `ClinicalSummaryBlock` needs — see the
    // constant — but `RawBlock` is derived from `PointOfCareBlock`, which
    // declares a narrower shape. The rows carry the data; this restates that
    // at the one boundary where the summary helpers are called.
    const withChips = (b: RawBlock) =>
      ({
        ...b,
        observation_chips_list: (entriesByBlockAll.get(b.id) ?? []).map(
          (e) => e.observation_chips,
        ),
      }) as unknown as ClinicalSummaryBlock;

    const watchSource = pickPreClientWatchPlanSource(
      candidates,
      new Map(
        candidates.map((c) => [
          c.id,
          blocksOf(c.id) as unknown as ReadonlyArray<
            Pick<ClinicalSummaryBlock, "caution_for_next_session" | "caution_note">
          >,
        ]),
      ),
    );
    const watchPlan = watchSource
      ? buildLastSessionSummary({
          blocks: blocksOf(watchSource.id).map(withChips),
          nextSessionNote: watchSource.next_session_note ?? null,
        })
      : null;

    const intelligence = buildTreatmentIntelligence({
      sessionsNewestFirst:
        candidates as unknown as Parameters<
          typeof buildTreatmentIntelligence
        >[0]["sessionsNewestFirst"],
      blocks: candidates.flatMap((c) =>
        blocksOf(c.id).map((b) => ({
          ...(withChips(b) as object),
          structured_areas: orderAreas(b.structured_areas ?? []),
          entry_hairs: [],
        })),
      ) as unknown as Parameters<typeof buildTreatmentIntelligence>[0]["blocks"],
    });

    const selectedBlocks = selected ? blocksOf(selected.id) : [];
    const selectedSummary = selected
      ? buildLastSessionSummary({
          blocks: selectedBlocks.map(withChips),
          nextSessionNote: selected.next_session_note ?? null,
        })
      : null;

    return buildPreVisitBriefing({
      lastTreatment: selected
        ? {
            startedAt: selected.started_at,
            modality: selected.modality,
            areaNames: selectedSummary?.areas.map((a) => a.name) ?? [],
            aftercareExplainedAt:
              (selected as { aftercare_and_risks_explained_at?: string | null })
                .aftercare_and_risks_explained_at ?? null,
            blockLots: selectedBlocks.map((b) => b.probe_lot_number ?? null),
            blockMinutes: selectedBlocks.map((b) =>
              b.minutes_performed == null ? null : Number(b.minutes_performed),
            ),
            blockReactionNotes: selectedBlocks.map(
              (b) => b.reaction_notes ?? null,
            ),
          }
        : null,
      watchPlan,
      intelligence,
      client: {
        dateOfBirth: r.client.dateOfBirth,
        phone: r.client.phone,
        address: r.client.address,
      },
    });
  }

  for (const r of requests) {
    const candidates = candidatesByRequest.get(r.requestKey) ?? [];
    // Narrative is resolved from the candidates already held, independently of
    // the block read, so it survives "nothing charted" and "blocks failed".
    const narrative = {
      plan: newestPlanOf(candidates),
      legacySessionNotes: newestLegacyNotesOf(candidates),
    };

    if (blocksUnavailable) {
      out.set(r.requestKey, {
        treatment: null,
        unavailable: true,
        narrative,
        // The block read failed, so no setup/caution can be derived. The notes
        // survive because they come from the session rows already held.
        briefing: briefingFor(r, candidates, null),
      });
      continue;
    }
    if (candidates.length === 0) {
      // Truthful: with a truncated window we did not prove there is nothing.
      out.set(r.requestKey, {
        treatment: null,
        unavailable: truncated,
        narrative,
        briefing: briefingFor(r, candidates, null),
      });
      continue;
    }

    const selected = pickNewestChartedSession(candidates, blocksBySession);
    if (!selected) {
      // Same truthfulness rule as the zero-candidate branch above, and it was
      // missing here. Candidates exist but none carries charting — which is
      // the COMMON abandoned-empty-session shape — so with a truncated window
      // the client's real treatment may simply have fallen below the global
      // cut while their recent empties survived. Reporting `false` there is an
      // unproven absence: exactly what this module's own contract forbids.
      out.set(r.requestKey, {
        treatment: null,
        unavailable: truncated,
        narrative,
        // Positive facts that WERE read still render: each client's slice is a
        // recency prefix, so a caution or plan found in it is real. Only the
        // ABSENCE claim is unproven under truncation, and that is what
        // `unavailable` carries.
        briefing: briefingFor(r, candidates, null),
      });
      continue;
    }

    const entriesByBlock = new Map<string, PointOfCareEntry[]>();
    for (const entry of selected.electrolysis_entries ?? []) {
      if (entry.deleted_at != null) continue;
      const blockId = entry.block_id;
      if (!blockId) continue;
      const bucket = entriesByBlock.get(blockId);
      if (bucket) bucket.push(entry);
      else entriesByBlock.set(blockId, [entry]);
    }
    const blocks: PointOfCareBlock[] = (blocksBySession.get(selected.id) ?? []).map(
      (b) => ({
        ...b,
        structured_areas: orderAreas(b.structured_areas ?? []),
        entries: entriesByBlock.get(b.id) ?? [],
      }),
    );

    out.set(r.requestKey, {
      treatment: {
        session: selected,
        blocks,
        supersededByEmptySession: candidates[0]?.id !== selected.id,
      },
      unavailable: false,
      narrative,
      // POSITIVE EVIDENCE ONLY, WHICH IS WHY NO COMPLETENESS FLAG TRAVELS
      // WITH IT. A truncated window still yields a safe selected treatment —
      // the slice is a newest-first prefix, so the newest is guaranteed
      // present — and any note, caution or setup found in it is real.
      //
      // What the window CANNOT support is an absence: a note outside the slice
      // may have been evicted by another client's rows, by the per-client cut,
      // or by the cap on the block read. An earlier design carried a
      // `briefingComplete` flag so the Dashboard could license those absence
      // claims. It was removed with the claims themselves — four P1s proved
      // that every unreported narrowing point produces another false negative,
      // and a question nobody asks needs no proof. Consumers render what is
      // here and say nothing about what is not.
      briefing: briefingFor(r, candidates, selected),
    });
  }

  return out;
}
