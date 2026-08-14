import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { buildAreaMinutesBreakdown } from "./area-bucket";
import type { TreatmentGoal } from "@/lib/types/database";
import type {
  AreaBreakdownRow,
  EmailTreatmentTimeContext,
  SessionRunningTotal,
  TotalTreatmentTime,
} from "./format";

// Treatment time tracking is electrolysis-only. Laser sessions don't go
// through the block model with minutes_performed, so they're excluded
// from every helper here. The UI surfaces a 0m placeholder with a note
// when a client has no electrolysis sessions.

export type {
  AreaBreakdownRow,
  EmailTreatmentTimeContext,
  SessionRunningTotal,
  TotalTreatmentTime,
} from "./format";

export {
  buildTreatmentTimeLine,
  formatMinutes,
  relativeLastSession,
} from "./format";

// Single round-trip: load all non-deleted electrolysis sessions for the
// client (id + started_at) plus the associated non-deleted block minutes.
// Sum + count in app code so the helpers below can reuse the same rows.
//
// Body Chart v1 Phase C selected session_blocks.primary_area and bucketed on
// it. That was the FIRST area of a multi-area block (migration 0128 defines
// primary_area as exactly that), so a block treating Left cheek + Right
// sideburn credited its whole duration to Cheek and the sideburn disappeared
// from the breakdown. The structured child rows are now selected in the SAME
// embed (still one round-trip, no N+1) and the bucket label is resolved by
// lib/treatment-time/area-bucket.ts, which credits a multi-area block ONCE to
// one combined bucket. primary_area is retained as the legacy fallback. The
// total-minutes and session-number helpers don't read either, so the extra
// columns are free to them.
type Row = {
  id: string;
  started_at: string;
  studio_id: string;
  blocks: Array<{
    block_name: string | null;
    primary_area: string | null;
    minutes_performed: number | null;
    deleted_at: string | null;
    // Migration 0128 structured areas. Present (possibly empty) on every row;
    // these child rows have no soft-delete of their own and are reachable only
    // through a live parent block, which the filter below already guarantees.
    structured_areas: Array<{
      area: string;
      display_order: number | null;
      created_at: string | null;
      id: string | null;
    }> | null;
  }>;
};

async function loadElectrolysisRows(
  studioId: string,
  clientId: string,
): Promise<Row[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, started_at, studio_id, blocks:session_blocks(block_name, primary_area, minutes_performed, deleted_at, structured_areas:session_block_areas(id, area, display_order, created_at))",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("modality", "electrolysis")
    .is("deleted_at", null)
    .order("started_at", { ascending: false });
  if (error) {
    throw new Error(`Failed to load sessions for treatment time: ${error.message}`);
  }
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    ...r,
    blocks: (r.blocks ?? []).filter((b) => b.deleted_at == null),
  }));
}

function sumMinutesForRow(row: Row): number {
  return row.blocks.reduce((acc, b) => acc + (b.minutes_performed ?? 0), 0);
}

export async function getTotalTreatmentTime(
  studioId: string,
  clientId: string,
): Promise<TotalTreatmentTime> {
  const rows = await loadElectrolysisRows(studioId, clientId);
  let totalMinutes = 0;
  for (const r of rows) totalMinutes += sumMinutesForRow(r);
  // rows is sorted descending by started_at, so [0] is the most recent.
  const lastSessionAt = rows.length > 0 ? rows[0].started_at : null;
  return {
    totalMinutes,
    sessionCount: rows.length,
    lastSessionAt,
  };
}

// The structured child rows are authoritative; legacy blocks continue to flow
// through primary_area and then bucketize(block_name). The result is still a
// single Area-layer breakdown with no side fragmentation: `Underarms · left`
// still rolls up into `Underarms`, but a block that treated SEVERAL areas now
// buckets under one combined label naming all of them, credited exactly once,
// instead of silently crediting only its first area. See
// lib/treatment-time/area-bucket.ts for the full rule.
export async function getTreatmentTimeByArea(
  studioId: string,
  clientId: string,
): Promise<AreaBreakdownRow[]> {
  const rows = await loadElectrolysisRows(studioId, clientId);
  // The attribution itself is pure and lives in ./area-bucket, so the invariant
  // "the breakdown sums to the same total as getTotalTreatmentTime" is proved
  // by unit test against this exact code rather than a replica of it.
  return buildAreaMinutesBreakdown(rows.flatMap((r) => r.blocks));
}

export async function getTreatmentGoal(
  studioId: string,
  clientId: string,
): Promise<TreatmentGoal | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("treatment_goals")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load treatment goal: ${error.message}`);
  return (data ?? null) as TreatmentGoal | null;
}

// Returns the 1-indexed sequence number of this session within the
// client's electrolysis history, plus the total minutes treated BEFORE
// this session started. Used by the session detail "Session N · Xh Ym
// total before today" line.

export async function getSessionNumberForClient(
  studioId: string,
  clientId: string,
  sessionId: string,
): Promise<SessionRunningTotal | null> {
  const rows = await loadElectrolysisRows(studioId, clientId);
  // loadElectrolysisRows returns descending; iterate ascending so the
  // running total accumulates in chronological order.
  const ascending = [...rows].reverse();
  let totalMinutesBefore = 0;
  let index = 0;
  for (const r of ascending) {
    index += 1;
    if (r.id === sessionId) {
      return { sessionNumber: index, totalMinutesBefore };
    }
    totalMinutesBefore += sumMinutesForRow(r);
  }
  // The requested session wasn't found in the client's electrolysis
  // history (might be laser, or wrong client). Returning null lets the
  // caller skip the running-total line.
  return null;
}

// Phase D: actual logged treatment time aggregated per treatment plan.
//
// Single batched query keyed on the supplied plan ids. Filters mirror
// the client-wide loadElectrolysisRows() helper exactly:
//   - sessions.studio_id = studioId
//   - sessions.treatment_plan_id IN planIds
//   - sessions.deleted_at IS NULL
//   - sessions.modality = 'electrolysis'        (same scope as TTT)
//   - session_blocks.deleted_at IS NULL         (filtered in-app)
//
// Returns a Map keyed by plan_id. Plans with no attached electrolysis
// sessions are present in the map with { minutes: 0, sessionCount: 0 }
// so callers can do a simple Map.get() without branching for absent
// keys.
//
// No createAdminClient; this is purely the user-scoped RLS path. The
// per-plan visit count returned here is electrolysis-only; the
// existing `attached_count` in lib/treatment-plans/queries.ts counts
// sessions of any modality and remains the source of truth for the
// legacy "visits" progress bar.
export async function getActualMinutesForPlans(
  studioId: string,
  planIds: ReadonlyArray<string>,
): Promise<Map<string, { minutes: number; sessionCount: number }>> {
  const result = new Map<string, { minutes: number; sessionCount: number }>();
  for (const id of planIds) {
    result.set(id, { minutes: 0, sessionCount: 0 });
  }
  if (planIds.length === 0) return result;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select(
      "id, treatment_plan_id, blocks:session_blocks(minutes_performed, deleted_at)",
    )
    .eq("studio_id", studioId)
    .in("treatment_plan_id", planIds as string[])
    .eq("modality", "electrolysis")
    .is("deleted_at", null);
  if (error) {
    throw new Error(
      `Failed to load actual minutes for plans: ${error.message}`,
    );
  }

  type Row = {
    id: string;
    treatment_plan_id: string | null;
    blocks: Array<{
      minutes_performed: number | null;
      deleted_at: string | null;
    }>;
  };
  for (const r of (data ?? []) as unknown as Row[]) {
    if (!r.treatment_plan_id) continue;
    const cur = result.get(r.treatment_plan_id);
    if (!cur) continue;
    cur.sessionCount += 1;
    for (const b of r.blocks ?? []) {
      if (b.deleted_at != null) continue;
      cur.minutes += b.minutes_performed ?? 0;
    }
  }
  return result;
}

// Admin-client variant used by the email pipeline (cron + booking action).
// Returns the count of electrolysis sessions and the total minutes BEFORE
// "now". Used for "This will be session N" / "Treatment time so far".

export async function getTreatmentTimeContextForEmail(
  studioId: string,
  clientId: string,
): Promise<EmailTreatmentTimeContext> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("sessions")
    .select(
      "id, started_at, blocks:session_blocks(minutes_performed, deleted_at)",
    )
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("modality", "electrolysis")
    .is("deleted_at", null);
  if (error) {
    throw new Error(`Failed to load treatment time context: ${error.message}`);
  }
  let totalMinutes = 0;
  const rows = (data ?? []) as unknown as Array<{
    blocks: Array<{ minutes_performed: number | null; deleted_at: string | null }>;
  }>;
  for (const r of rows) {
    for (const b of r.blocks ?? []) {
      if (b.deleted_at != null) continue;
      totalMinutes += b.minutes_performed ?? 0;
    }
  }
  return { totalMinutes, sessionCount: rows.length };
}

