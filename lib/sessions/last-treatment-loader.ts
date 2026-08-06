import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  chartedSessionCandidates,
  groupBlocksBySession,
  pickNewestChartedSession,
  type ChartedSessionCandidate,
} from "@/lib/sessions/charted-session";
import type {
  PointOfCareBlock,
  PointOfCareEntry,
} from "@/lib/sessions/point-of-care-memory";
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
const BLOCK_COLUMNS =
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
  if (candidates.length === 0) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select(BLOCK_COLUMNS)
    // RLS already scopes to the caller's studio; the explicit filter is
    // defence-in-depth so a foreign session id could never surface a block.
    .eq("studio_id", input.studioId)
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
        studio_id: input.studioId,
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
  };
}
