import "server-only";
import { createClient } from "@/lib/supabase/server";
import type {
  PointOfCareBlock,
  PointOfCareEntry,
} from "@/lib/sessions/point-of-care-memory";
import type {
  PrepLaserEntry,
  PrepOrphanEntry,
} from "@/lib/sessions/appointment-prep-memory";
import type { BlockArea } from "@/lib/sessions/block-areas";

// THE ONE CANONICAL FULL-DETAIL CLINICAL PROJECTION.
//
// WHY THIS FILE IS THE WHOLE POINT
// --------------------------------
// The repository grew SIX different hand-written subsets of the same clinical
// record — one per surface — and the newest of them carried two of the
// seventeen treatment-entry columns. A visit that recorded six electrolysis
// passes rendered with no hair count; a laser visit's only narrative
// (`zone`, `observation_notes`) was not selected at all, so the card fell back
// to "Open the full chart to review what was recorded"; and a pre-0019
// entry-only visit rendered "This previous visit has no charted treatment
// areas" — a FALSE ABSENCE about a visit that plainly recorded treatment.
//
// So there is ONE projection, and it is `select("*")`.
//
// That is not laziness, it is the mechanism: a projection with no column list
// has no column list to drift. Adding a clinically relevant treatment field
// becomes a schema change and a render change, and touches NOTHING here. The
// alternative — a shared constant naming every column — still has to be edited,
// and the six subsets each began life as exactly such a constant.
//
// WHAT REUSE LOOKS LIKE HERE
// --------------------------
// The clinical MODEL is reused wholesale: `PointOfCareBlock`, `PointOfCareEntry`,
// `PrepLaserEntry` and `PrepOrphanEntry` are the product's existing types and no
// new clinical model is introduced. The `select("*")` discipline is reused from
// `getSessionWithBlocks` (lib/supabase/queries.ts), which is the fullest
// clinical read in the product and already works this way.
//
// The READ is batched rather than delegating to `getSessionWithBlocks` or
// `getSessionForClient`, because both take a single session id: a roster of a
// dozen appointments would issue a dozen round-trips per table. Those helpers
// keep their own job — the session being CHARTED, which is a different question
// from a historical visit — and this module is the single historical one.
//
// ON-DEMAND, NOT EAGER. Nothing here runs for a roster row until the authority
// has already SELECTED which visit is the previous one, so at most one visit per
// appointment is ever read, and the full record crosses to the browser only when
// a practitioner opens the disclosure.

/**
 * Declared bounds, all comfortably under PostgREST's `max_rows` (1000).
 *
 * A declared bound is what makes truncation OBSERVABLE. Without one the real
 * bound is the server's invisible cap and an exactly-full response is
 * indistinguishable from a truncated one, so no detector can even be written. If
 * a bound ever exceeded `max_rows` the server would clamp BELOW it, `returned`
 * could never reach it, and every truncated read would report itself complete.
 */
export const DETAIL_MAX_BLOCK_ROWS = 500;
export const DETAIL_MAX_ENTRY_ROWS = 900;
export const DETAIL_MAX_LASER_ROWS = 500;
export const DETAIL_MAX_AREA_ROWS = 900;

/**
 * One historical visit's complete clinical record.
 *
 * Every channel a visit can have recorded treatment through is present, because
 * omitting one is indistinguishable from the visit not having used it:
 *
 *   blocks        — settings-charted treatment, each with its own passes;
 *   orphanEntries — pre-0019 passes with no block, which are genuinely charted;
 *   laserEntries  — laser passes, whose zone and observation notes are the only
 *                   narrative a laser visit has.
 */
export type HistoricalVisitDetail = {
  readonly sessionId: string;
  readonly blocks: ReadonlyArray<PointOfCareBlock>;
  readonly orphanEntries: ReadonlyArray<PrepOrphanEntry>;
  readonly laserEntries: ReadonlyArray<PrepLaserEntry>;
};

/**
 * What we hold for one visit's detail.
 *
 * `complete` is proven by COMPARISON against the live block count the session
 * row already carried, never by where a cut happened to fall — and never by
 * default, because defaulting an unknown to complete is what turns a missing map
 * entry into a clinical denial.
 */
export type HistoricalVisitDetailResult =
  | { kind: "complete"; detail: HistoricalVisitDetail }
  | { kind: "partial"; detail: HistoricalVisitDetail; expectedBlocks: number }
  | { kind: "failed" };

type Row = Record<string, unknown>;

function groupBy<T>(rows: ReadonlyArray<T>, key: (row: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k == null) continue;
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

/**
 * Read the complete clinical record for visits the authority already selected.
 *
 * `expectedLiveBlocks` comes from the selection read's count on each session
 * row, so "did I receive all of this visit's blocks?" is a comparison rather
 * than a guess. A session whose expectation is unknown can never be certified
 * complete.
 *
 * STUDIO AUTHORITY IS RE-DERIVED HERE. The two tables that carry `studio_id`
 * are filtered on it explicitly; `electrolysis_entries` and `laser_entries` have
 * no such column and are reached through `session_id`, under RLS. A caller
 * cannot widen its own scope by handing in a session id from another studio: the
 * blocks read would return nothing for it, and its entries are invisible to RLS.
 */
export async function loadHistoricalVisitDetails(input: {
  studioId: string;
  sessionIds: ReadonlyArray<string>;
  expectedLiveBlocks?: ReadonlyMap<string, number | null>;
}): Promise<Map<string, HistoricalVisitDetailResult>> {
  const out = new Map<string, HistoricalVisitDetailResult>();
  const sessionIds = [...new Set(input.sessionIds)].filter(Boolean);
  if (sessionIds.length === 0) return out;

  const supabase = await createClient();

  // ONE canonical projection, four relations, no column list anywhere.
  const [blocksRes, entriesRes, laserRes] = await Promise.all([
    supabase
      .from("session_blocks")
      .select("*")
      .eq("studio_id", input.studioId)
      .in("session_id", sessionIds)
      .is("deleted_at", null)
      // Within a session, `sort_order` is the display key; ACROSS sessions it
      // means nothing, so it is applied only after `session_id`. `id` terminates
      // it because (session_id, sort_order) carries no unique constraint.
      .order("session_id", { ascending: true })
      .order("sort_order", { ascending: true })
      .order("id", { ascending: true })
      .limit(DETAIL_MAX_BLOCK_ROWS),
    supabase
      .from("electrolysis_entries")
      .select("*")
      .in("session_id", sessionIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(DETAIL_MAX_ENTRY_ROWS),
    supabase
      .from("laser_entries")
      .select("*")
      .in("session_id", sessionIds)
      .is("deleted_at", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(DETAIL_MAX_LASER_ROWS),
  ]);

  const firstError = blocksRes.error ?? entriesRes.error ?? laserRes.error;
  if (firstError) {
    // CLASSIFICATION ONLY. A raw PostgREST message echoes the failing statement,
    // which after `select("*")` names every clinical column and every session id.
    console.error(
      JSON.stringify({
        event: "historical_visit_detail_read_failed",
        code: typeof firstError.code === "string" ? firstError.code : null,
        studio_id: input.studioId,
        session_count: sessionIds.length,
        at: new Date().toISOString(),
      }),
    );
    for (const id of sessionIds) out.set(id, { kind: "failed" });
    return out;
  }

  const blockRows = (blocksRes.data ?? []) as unknown as Array<Row & { id: string; session_id: string }>;
  const entryRows = (entriesRes.data ?? []) as unknown as Array<Row & { session_id: string; block_id: string | null }>;
  const laserRows = (laserRes.data ?? []) as unknown as Array<Row & { session_id: string }>;

  // Structured areas (migration 0128) for the blocks actually returned. When
  // present they are authoritative: a Cheeks + Sideburns block is TWO treated
  // areas, and dropping them silently degrades every multi-area visit to its
  // legacy `primary_area`.
  const areasByBlock = new Map<string, BlockArea[]>();
  if (blockRows.length > 0) {
    const areasRes = await supabase
      .from("session_block_areas")
      .select("*")
      .eq("studio_id", input.studioId)
      .in("session_block_id", blockRows.map((b) => b.id))
      .order("display_order", { ascending: true })
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(DETAIL_MAX_AREA_ROWS);
    if (areasRes.error) {
      console.error(
        JSON.stringify({
          event: "historical_visit_detail_read_failed",
          code: typeof areasRes.error.code === "string" ? areasRes.error.code : null,
          studio_id: input.studioId,
          session_count: sessionIds.length,
          at: new Date().toISOString(),
        }),
      );
      for (const id of sessionIds) out.set(id, { kind: "failed" });
      return out;
    }
    for (const area of (areasRes.data ?? []) as unknown as Array<{
      session_block_id: string;
      area: string;
      laterality: BlockArea["laterality"];
    }>) {
      const bucket = areasByBlock.get(area.session_block_id) ?? [];
      bucket.push({ area: area.area, laterality: area.laterality });
      areasByBlock.set(area.session_block_id, bucket);
    }
  }

  const blocksBySession = groupBy(blockRows, (b) => b.session_id);
  const entriesBySession = groupBy(entryRows, (e) => e.session_id);
  const laserBySession = groupBy(laserRows, (l) => l.session_id);

  for (const sessionId of sessionIds) {
    const rawBlocks = blocksBySession.get(sessionId) ?? [];
    const sessionEntries = entriesBySession.get(sessionId) ?? [];
    const entriesByBlock = groupBy(sessionEntries, (e) => e.block_id ?? null);

    const blocks: PointOfCareBlock[] = rawBlocks.map((b) => ({
      ...(b as unknown as PointOfCareBlock),
      structured_areas: areasByBlock.get(b.id) ?? [],
      // Every pass belonging to this block, carried on the block itself so a
      // caller cannot forget to attach them.
      entries: (entriesByBlock.get(b.id) ?? []) as unknown as ReadonlyArray<PointOfCareEntry>,
    }));

    // Pre-0019 passes with no block. These are genuinely charted treatment and
    // are the ONLY channel a legacy entry-only visit has.
    const orphanEntries = sessionEntries.filter(
      (e) => e.block_id == null,
    ) as unknown as ReadonlyArray<PrepOrphanEntry>;

    const detail: HistoricalVisitDetail = {
      sessionId,
      blocks,
      orphanEntries,
      laserEntries: (laserBySession.get(sessionId) ?? []) as unknown as ReadonlyArray<PrepLaserEntry>,
    };

    const expected = input.expectedLiveBlocks?.get(sessionId);
    if (expected == null) {
      // Unknown expectation cannot certify completeness.
      out.set(sessionId, {
        kind: "partial",
        detail,
        expectedBlocks: blocks.length,
      });
      continue;
    }
    out.set(
      sessionId,
      blocks.length >= expected
        ? { kind: "complete", detail }
        : { kind: "partial", detail, expectedBlocks: expected },
    );
  }

  return out;
}

/**
 * The exact-session, on-demand read: one visit's complete record.
 *
 * A thin wrapper on the batched form ON PURPOSE — one implementation means one
 * projection, so the disclosure surface and the roster cannot receive different
 * subsets of the same clinical record.
 */
export async function loadHistoricalVisitDetail(input: {
  studioId: string;
  sessionId: string;
  expectedLiveBlocks?: number | null;
}): Promise<HistoricalVisitDetailResult> {
  const map = await loadHistoricalVisitDetails({
    studioId: input.studioId,
    sessionIds: [input.sessionId],
    expectedLiveBlocks: new Map([[input.sessionId, input.expectedLiveBlocks ?? null]]),
  });
  return map.get(input.sessionId) ?? { kind: "failed" };
}
