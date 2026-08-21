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
  observeCaution,
  observeLatestSetup,
  type PrepCautionObservation,
  type PrepSetupObservation,
} from "@/lib/sessions/prep-observations";
import {
  absentMeansEmpty,
  classifyBlockReadCoverage,
  type BlockReadCoverage,
} from "@/lib/sessions/block-read-coverage";

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

// EXPLICIT bound on the batched block read.
//
// It was previously unbounded, which did NOT mean "unlimited": PostgREST clamps
// every response at `max_rows` (supabase/config.toml), and a clamped response is
// a 200 with fewer rows and NO error — indistinguishable from a complete read.
// The repo already documents this hazard, including the parent/child
// amplification, at lib/export/paginate.ts.
//
// Stating the bound here does two things the silent clamp could not. It makes
// the ceiling OURS, so it is visible in review and pinned by a test rather than
// inherited from a config file two directories away. And it makes exhaustion
// OBSERVABLE, so the loader can report a read it could not finish instead of
// quietly returning a short map.
//
// It is deliberately NOT paginated. Paginating here would add round-trips to
// the Dashboard's hot path to chase a completeness guarantee the surface does
// not need: under the positive-evidence model an unread block can only cause a
// fact to be OMITTED, never negated. lib/export/paginate.ts remains the right
// tool where completeness genuinely matters, and the export is where it is used.
const MAX_BATCH_BLOCK_ROWS = 1000;

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


// Raw block rows, normalised into the shape the shared pure helpers expect.
//
// The area ORDER is established here for the same reason it is established for
// the selected treatment: PostgREST does not order embedded rows reliably, so
// an unordered `structured_areas` would let the same block produce a different
// area label on the observation path than on the treatment path.
function toPointOfCareBlocks(
  rows: ReadonlyArray<RawBlock>,
): PointOfCareBlock[] {
  return rows.map((b) => ({
    ...b,
    structured_areas: orderAreas(b.structured_areas ?? []),
  }));
}

// COULD A NEWER TREATMENT HAVE BEEN HIDDEN BY THE BOUNDED BLOCK READ?
//
// `pickNewestChartedSession` walks candidates newest-first and skips any that
// fails `hasChartedContent`. That test is satisfied by a live BLOCK or by a live
// embedded ENTRY, and the entries ride along on the SESSION read — so a
// candidate with live entries is decidable no matter what the block read
// returned.
//
// The gap is a BLOCK-ONLY session: genuinely charted, zero live entries, and all
// of its block rows missing from a truncated read. `hasChartedContent` reads
// that as "not charted", the walk continues, and an OLDER session is selected
// and rendered as "Last treatment" — the same superlative-from-partial-evidence
// defect as the setup line, in the more consequential position.
//
// This asks the narrow question that actually matters: strictly NEWER than the
// row we picked, is there a candidate we could not resolve either way? Ties and
// older rows are irrelevant, and under complete coverage the answer is always
// no, so the common path pays nothing.
function newerCandidateUnresolved<T extends SessionWithLoadedEntries>(
  candidatesNewestFirst: ReadonlyArray<T>,
  selectedId: string,
  blocksBySession: ReadonlyMap<string, ReadonlyArray<{ deleted_at?: string | null }>>,
  coverage: BlockReadCoverage,
): boolean {
  if (absentMeansEmpty(coverage)) return false;
  for (const candidate of candidatesNewestFirst) {
    // Candidates are newest-first, so everything from here on is older.
    if (candidate.id === selectedId) return false;
    const blocks = blocksBySession.get(candidate.id);
    // A candidate with ANY block read already satisfies hasChartedContent, so
    // it would have won the selection; reaching here means it did not.
    if (blocks && blocks.length > 0) continue;
    const liveEntries =
      (candidate.electrolysis_entries ?? []).some((e) => e.deleted_at == null) ||
      (candidate.laser_entries ?? []).some((e) => e.deleted_at == null);
    // Entries came from the SESSION read, so their absence IS authoritative.
    if (liveEntries) continue;
    return true; // no blocks read, no entries: we cannot say whether it charted.
  }
  return false;
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
  const { outcome } = await selectFromCandidates(input.studioId, candidates);
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
): Promise<{
  outcome: SelectOutcome<T>;
  // The WHOLE candidate window's blocks, not only the selected session's.
  //
  // Returned rather than discarded so the appointment-prep companion can make
  // its positive caution/setup observations from the read it already paid for.
  // Empty on a failed read; an empty map is never evidence of anything.
  blocksBySession: Map<string, PointOfCareBlock[]>;
  // How much of that read we actually saw. Travels with the map, because the
  // map alone cannot say whether a missing key means "empty" or "unread".
  coverage: BlockReadCoverage;
}> {
  if (candidates.length === 0) {
    return {
      outcome: { status: "none" },
      blocksBySession: new Map(),
      // No ids were asked for, so nothing could have been cut.
      coverage: { kind: "complete" },
    };
  }

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
    .order("sort_order", { ascending: true })
    .limit(MAX_BATCH_BLOCK_ROWS);

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
    return {
      outcome: { status: "unavailable" },
      blocksBySession: new Map(),
      coverage: { kind: "complete" },
    };
  }

  const rows = (data ?? []) as unknown as RawBlock[];
  const coverage = classifyBlockReadCoverage(rows.length, MAX_BATCH_BLOCK_ROWS);
  const bySession = groupBlocksBySession(rows);
  // The normalised window, built once and shared by the selector below and by
  // the caller's positive observations.
  const observedBlocks = new Map<string, PointOfCareBlock[]>();
  for (const [sessionId, blockRows] of bySession) {
    observedBlocks.set(sessionId, toPointOfCareBlocks(blockRows));
  }
  // THE selector, not a second copy of its rule. `candidates` is already the
  // filtered, ordered, bounded window, so this only applies the content half,
  // but routing it through pickNewestChartedSession is what guarantees the
  // charting page, the new-session panel and the unit/DB tests can never drift
  // apart on what "the last treatment" means.
  const selected = pickNewestChartedSession(candidates, bySession);
  // A SUCCESSFUL read that found nothing charted. Distinct from the failure
  // above, and the distinction is the whole point of this type.
  if (!selected) {
    return {
      outcome: { status: "none" },
      blocksBySession: observedBlocks,
      coverage,
    };
  }
  // A newer candidate we could not resolve means this one cannot be called the
  // LAST treatment. "Could not be loaded" is the truthful answer to the question
  // that was asked, and it is the vocabulary this contract already owns.
  if (newerCandidateUnresolved(candidates, selected.id, bySession, coverage)) {
    return {
      outcome: { status: "unavailable" },
      blocksBySession: observedBlocks,
      coverage,
    };
  }

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
    outcome: {
      status: "selected",
      treatment: {
        session: selected,
        blocks,
        supersededByEmptySession: candidates[0]?.id !== selected.id,
      },
    },
    blocksBySession: observedBlocks,
    coverage,
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
  // `aftercare_and_risks_explained_at` is a SCALAR on the session row, and it is
  // the only evidence that licenses the "Aftercare not marked" reminder. Reading
  // it here is a COLUMN widening on a query that already runs: it costs no
  // round-trip and no wave, and it is what let the Dashboard stop asking a
  // second, unbounded, error-discarding pipeline for the same fact.
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
  // The scalar behind the "Aftercare not marked" reminder. Selected above, and
  // read ONLY off a session row that was actually returned — never inferred
  // from a session that is missing from a collection.
  aftercare_and_risks_explained_at?: string | null;
};

// "No prior treatment" and "the read failed" are CLINICALLY DIFFERENT answers,
// and the appointment page renders a sentence for the first one. Collapsing
// both into null made a transient timeout on a forty-visit client read as a
// confident "No previous treatment charted for this client.", which the code
// this replaced could never do, because it threw instead.
export type AppointmentPrepLoad = {
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
  // POSITIVE OBSERVATIONS over the SAME candidate window and the SAME batched
  // block read, computed by the shared pure observers in prep-observations.ts.
  //
  // They exist so the Dashboard can stop running a second historical pipeline
  // for the caution and the setup line. That pipeline had no `before` bound, no
  // void filter and no own-appointment exclusion, so on Today it could source a
  // caution from a voided session, from a session that started earlier the same
  // day, or from a future booking. These are bounded by construction, because
  // they read the window this loader already filtered.
  //
  // `null` means NOT OBSERVED. It never means "there is none", and no caller may
  // render a sentence about it: the block map behind them can be short.
  observed: {
    caution: PrepCautionObservation | null;
    latestSetup: PrepSetupObservation | null;
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
      observed: { caution: null, latestSetup: null },
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

  const { outcome, blocksBySession, coverage } = await selectFromCandidates(input.studioId, candidates);
  // Positive observations over the window we just read. Resolved for EVERY
  // outcome, including "none" and "unavailable": a caution recorded on a visit
  // that carries no charting is still a caution we read, and discarding it
  // because the treatment selector found nothing would hide a safety
  // instruction already in hand.
  const observed = {
    caution: observeCaution(candidates, blocksBySession),
    latestSetup: observeLatestSetup(candidates, blocksBySession, coverage),
  };
  switch (outcome.status) {
    case "selected":
      return { treatment: outcome.treatment, unavailable: false, narrative, observed };
    case "none":
      // Reads succeeded; this client genuinely has no charted prior treatment.
      // Narrative may still exist and must still be shown.
      return { treatment: null, unavailable: false, narrative, observed };
    case "unavailable":
      // The block read failed. Say so, and keep the narrative that WAS loaded,
      // discarding it would hide a safety instruction we already have in hand.
      return { treatment: null, unavailable: true, narrative, observed };
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
        observed: { caution: null, latestSetup: null },
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
  // Nothing was asked for until the read below runs, so nothing could be cut.
  let blockCoverage: BlockReadCoverage = { kind: "complete" };
  if (allCandidateIds.length > 0) {
    const { data: blockData, error: blockError } = await supabase
      .from("session_blocks")
      .select(BLOCK_COLUMNS)
      // RLS already scopes to the caller's studio; explicit for defence in depth.
      .eq("studio_id", input.studioId)
      .in("session_id", allCandidateIds)
      .is("deleted_at", null)
      .order("sort_order", { ascending: true })
      .limit(MAX_BATCH_BLOCK_ROWS);
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
      const blockRows = (blockData ?? []) as unknown as RawBlock[];
      blockCoverage = classifyBlockReadCoverage(
        blockRows.length,
        MAX_BATCH_BLOCK_ROWS,
      );
      blocksBySession = groupBlocksBySession(blockRows);
    }
  }

  // The batched window, normalised ONCE for every request's observations. Two
  // requests over the same client share the same block rows, so this is built
  // outside the loop rather than per request.
  const observedBlocks = new Map<string, PointOfCareBlock[]>();
  for (const [sessionId, blockRows] of blocksBySession) {
    observedBlocks.set(sessionId, toPointOfCareBlocks(blockRows));
  }

  for (const r of requests) {
    const candidates = candidatesByRequest.get(r.requestKey) ?? [];
    // Narrative is resolved from the candidates already held, independently of
    // the block read, so it survives "nothing charted" and "blocks failed".
    const narrative = {
      plan: newestPlanOf(candidates),
      legacySessionNotes: newestLegacyNotesOf(candidates),
    };
    // Positive observations over THIS request's own candidate window. Bounded
    // by that request's `before` and its own appointment exclusion, so two
    // appointments for one client observe two different windows.
    //
    // Resolved for every branch below, including the failure ones: a caution we
    // actually read stays readable even when the treatment selector found
    // nothing and even when the block read failed for other sessions.
    const observed = {
      caution: observeCaution(candidates, observedBlocks),
      latestSetup: observeLatestSetup(candidates, observedBlocks, blockCoverage),
    };

    if (blocksUnavailable) {
      out.set(r.requestKey, {
        treatment: null,
        unavailable: true,
        narrative,
        observed,
      });
      continue;
    }
    if (candidates.length === 0) {
      // Truthful: with a truncated window we did not prove there is nothing.
      out.set(r.requestKey, {
        treatment: null,
        unavailable: truncated,
        narrative,
        observed,
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
        observed,
      });
      continue;
    }

    // The SAME superlative guard the single-client path applies. A newer
    // candidate we could not resolve means this row cannot be called the LAST
    // treatment, so the truthful answer is the one this contract already owns.
    if (
      newerCandidateUnresolved(candidates, selected.id, blocksBySession, blockCoverage)
    ) {
      out.set(r.requestKey, {
        treatment: null,
        unavailable: true,
        narrative,
        observed,
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
      observed,
    });
  }

  return out;
}
