import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  StudioRecurringBreakRule,
  StudioTimedBlock,
} from "@/lib/types/database";

// Migration-order-safe SCOPED-UNAVAILABILITY loaders (PR B Part 3E-5).
//
// Timed blocks and recurring-break rules gained a nullable practitioner_id in
// migration 0137 (NULL = studio-wide, a UUID = one practitioner). These loaders
// serve every owner read path that manages that data, across all three states:
//
//   legacy          (capacity OFF): study-wide rows ONLY (practitioner_id IS
//                   NULL). Retained scoped rows created before rollback stay in
//                   the table but MUST NOT surface. They are dormant.
//   studio-default  (capacity ON, "All practitioners" view): every row for the
//                   studio: studio-wide PLUS all practitioner-scoped rows,
//                   INCLUDING rows scoped to now-inactive practitioners (so the
//                   owner can see and clean them up).
//   practitioner    (capacity ON, one practitioner selected): studio-wide rows
//                   PLUS only that practitioner's scoped rows.
//
// All three are ONE query (no N+1). Cross-tenant is impossible: every query is
// pinned to studio_id and RLS additionally scopes to the caller's studio.
//
// The legacy path queries practitioner_id IS NULL. If (and ONLY if) the
// column is genuinely absent (code running before 0137 is applied) it fails
// over to the exact pre-0137 query. Any OTHER error FAILS CLOSED. We never log
// query contents or row data, only a bounded operational marker.

type PgErr = { code?: string | null } | null | undefined;

// undefined_column (Postgres) / column-not-in-schema-cache (PostgREST).
const UNDEFINED_COLUMN_CODES = new Set(["42703", "PGRST204"]);

// Guards the practitioner id before it is interpolated into a PostgREST `.or()`
// filter string, so a malformed id can never inject filter syntax.
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUndefinedColumn(error: PgErr): boolean {
  return !!error && UNDEFINED_COLUMN_CODES.has(error.code ?? "");
}

function failClosed(error: PgErr, what: string): never {
  // Safe operational code only, never the raw message (which can echo data).
  throw new Error(`scoped_unavailability_read_failed:${what}:${error?.code ?? "unknown"}`);
}

function warnColumnAbsent(what: string): void {
  // Reached solely when the 0137 column is absent (pre-apply). Safe marker only.
  console.warn(`scoped_unavailability_column_absent:${what}`);
}

// The three read shapes, resolved by the caller from the capacity state + view.
export type ScopeLoad =
  | { mode: "legacy" }
  | { mode: "studio-default" }
  | { mode: "practitioner"; practitionerId: string };

// PostgREST `.or()` value that matches studio-wide rows plus one practitioner's.
function scopedOrFilter(practitionerId: string): string {
  if (!UUID_RE.test(practitionerId)) {
    // Never build a filter from an unvalidated id.
    failClosed({ code: "invalid_practitioner_id" }, "scope_filter");
  }
  return `practitioner_id.is.null,practitioner_id.eq.${practitionerId}`;
}

// -------------------------------------------------------------------------
// Upcoming timed blocks (current + future), scoped.
// -------------------------------------------------------------------------
export async function getScopedUpcomingTimedBlocksSafe(
  supabase: SupabaseClient,
  studioId: string,
  nowIso: string,
  scope: ScopeLoad,
): Promise<StudioTimedBlock[]> {
  let query = supabase
    .from("studio_timed_blocks")
    .select("*")
    .eq("studio_id", studioId)
    .gt("ends_at", nowIso);
  if (scope.mode === "legacy") {
    query = query.is("practitioner_id", null);
  } else if (scope.mode === "practitioner") {
    query = query.or(scopedOrFilter(scope.practitionerId));
  }
  // studio-default: no practitioner filter: all studio-wide + all scoped rows.
  const res = await query.order("starts_at");
  if (!res.error) return (res.data ?? []) as StudioTimedBlock[];
  if (!isUndefinedColumn(res.error)) failClosed(res.error, "timed_blocks");
  // Column absent, only reachable for a Legacy (pre-0137) studio, where the
  // only rows that exist are studio-wide. Fall back to the exact legacy query.
  warnColumnAbsent("timed_blocks");
  const legacy = await supabase
    .from("studio_timed_blocks")
    .select("*")
    .eq("studio_id", studioId)
    .gt("ends_at", nowIso)
    .order("starts_at");
  if (legacy.error) failClosed(legacy.error, "timed_blocks");
  return (legacy.data ?? []) as StudioTimedBlock[];
}

// -------------------------------------------------------------------------
// Recurring-break rules (active + inactive), scoped.
// -------------------------------------------------------------------------
export async function getScopedRecurringBreakRulesSafe(
  supabase: SupabaseClient,
  studioId: string,
  scope: ScopeLoad,
): Promise<StudioRecurringBreakRule[]> {
  let query = supabase
    .from("studio_recurring_break_rules")
    .select("*")
    .eq("studio_id", studioId);
  if (scope.mode === "legacy") {
    query = query.is("practitioner_id", null);
  } else if (scope.mode === "practitioner") {
    query = query.or(scopedOrFilter(scope.practitionerId));
  }
  const res = await query.order("created_at");
  if (!res.error) return (res.data ?? []) as StudioRecurringBreakRule[];
  if (!isUndefinedColumn(res.error)) failClosed(res.error, "recurring_rules");
  warnColumnAbsent("recurring_rules");
  const legacy = await supabase
    .from("studio_recurring_break_rules")
    .select("*")
    .eq("studio_id", studioId)
    .order("created_at");
  if (legacy.error) failClosed(legacy.error, "recurring_rules");
  return (legacy.data ?? []) as StudioRecurringBreakRule[];
}

// -------------------------------------------------------------------------
// Practitioner directory: TWO distinct concepts:
//   selectablePractitioners, ACTIVE, same-studio; the only valid targets for a
//     NEW or CHANGED scope. An inactive practitioner is never selectable.
//   practitionerDirectory  , ALL same-studio (active + inactive); used ONLY to
//     LABEL an existing scoped source (e.g. "Only Dana, inactive"). An inactive
//     practitioner's existing sources stay visible so the owner can reassign or
//     delete them; they simply cannot be chosen for a new target.
// `byId` is a lookup for O(1) labelling with no N+1.
// -------------------------------------------------------------------------
export type DirectoryPractitioner = {
  id: string;
  display_name: string;
  color: string;
  role: string;
  active: boolean;
};

export type PractitionerDirectory = {
  selectablePractitioners: DirectoryPractitioner[];
  practitionerDirectory: DirectoryPractitioner[];
  byId: Map<string, DirectoryPractitioner>;
};

export async function getPractitionerDirectory(
  supabase: SupabaseClient,
  studioId: string,
): Promise<PractitionerDirectory> {
  const { data, error } = await supabase
    .from("practitioners")
    .select("id, display_name, color, role, active")
    .eq("studio_id", studioId)
    .order("role", { ascending: true }) // 'owner' < 'practitioner'
    .order("display_name", { ascending: true });
  if (error) failClosed(error, "practitioner_directory");
  const all = (data ?? []) as DirectoryPractitioner[];
  return {
    practitionerDirectory: all,
    selectablePractitioners: all.filter((p) => p.active),
    byId: new Map(all.map((p) => [p.id, p])),
  };
}

// Label for a source's scope, given the directory. NULL/absent → studio-wide.
// A scoped source pointing at an inactive practitioner is flagged so the owner
// knows it must be reassigned before it can be re-activated. An id missing from
// the directory (deleted practitioner) degrades to a neutral, non-PII label.
export function scopeLabel(
  practitionerId: string | null,
  directory: Pick<PractitionerDirectory, "byId">,
): string {
  if (!practitionerId) return "All practitioners";
  const p = directory.byId.get(practitionerId);
  if (!p) return "A former practitioner";
  return p.active ? `Only ${p.display_name}` : `Only ${p.display_name}, inactive`;
}
