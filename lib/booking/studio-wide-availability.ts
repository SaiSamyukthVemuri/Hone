import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  StudioAvailabilityDefault,
  StudioAvailabilityOverride,
} from "@/lib/types/database";

// Migration-order-safe STUDIO-WIDE availability loaders (PR B Part 3A).
//
// The rollback lifecycle: capacity enabled -> per-practitioner rows created ->
// capacity disabled (rows RETAINED for future reactivation), means a flag-OFF
// studio can hold both studio-wide (practitioner_id IS NULL) AND practitioner
// rows. Every OFF read path (settings page, slot generation) and the flag-ON
// Studio-default scope MUST see ONLY the studio-wide rows, or a weekday/date
// would resolve to multiple rows (breaking the single-row UI + slot maybeSingle).
//
// These loaders query `practitioner_id IS NULL`. If (and ONLY if) the column
// is genuinely absent (code temporarily running before migration 0135 is
// applied) they fail over to the exact legacy studio-wide query. Any OTHER
// error (auth, network, malformed response, other DB error) FAILS CLOSED. We
// never log query contents or row data, only a safe operational marker.

type PgErr = { code?: string | null } | null | undefined;

// undefined_column (Postgres) / column-not-in-schema-cache (PostgREST).
const UNDEFINED_COLUMN_CODES = new Set(["42703", "PGRST204"]);

function isUndefinedColumn(error: PgErr): boolean {
  return !!error && UNDEFINED_COLUMN_CODES.has(error.code ?? "");
}

function failClosed(error: PgErr, what: string): never {
  // Safe operational code only, never the raw message (which can echo data).
  throw new Error(`availability_read_failed:${what}:${error?.code ?? "unknown"}`);
}

function warnColumnAbsent(what: string): void {
  // Safe marker only. Reached solely when the 0135 column is absent (pre-apply).
  // eslint-disable-next-line no-console
  console.warn(`availability_studio_wide_column_absent:${what}`);
}

export async function getStudioWideDefaultsSafe(
  supabase: SupabaseClient,
  studioId: string,
): Promise<StudioAvailabilityDefault[]> {
  const scoped = await supabase
    .from("studio_availability_default")
    .select("*")
    .eq("studio_id", studioId)
    .is("practitioner_id", null)
    .order("day_of_week");
  if (!scoped.error) return (scoped.data ?? []) as StudioAvailabilityDefault[];
  if (!isUndefinedColumn(scoped.error)) failClosed(scoped.error, "defaults");
  warnColumnAbsent("defaults");
  const legacy = await supabase
    .from("studio_availability_default")
    .select("*")
    .eq("studio_id", studioId)
    .order("day_of_week");
  if (legacy.error) failClosed(legacy.error, "defaults");
  return (legacy.data ?? []) as StudioAvailabilityDefault[];
}

export async function getStudioWideOverridesSafe(
  supabase: SupabaseClient,
  studioId: string,
  startDate: string,
  endDate: string,
): Promise<StudioAvailabilityOverride[]> {
  const scoped = await supabase
    .from("studio_availability_overrides")
    .select("*")
    .eq("studio_id", studioId)
    .is("practitioner_id", null)
    .gte("effective_date", startDate)
    .lte("effective_date", endDate)
    .order("effective_date");
  if (!scoped.error) return (scoped.data ?? []) as StudioAvailabilityOverride[];
  if (!isUndefinedColumn(scoped.error)) failClosed(scoped.error, "overrides");
  warnColumnAbsent("overrides");
  const legacy = await supabase
    .from("studio_availability_overrides")
    .select("*")
    .eq("studio_id", studioId)
    .gte("effective_date", startDate)
    .lte("effective_date", endDate)
    .order("effective_date");
  if (legacy.error) failClosed(legacy.error, "overrides");
  return (legacy.data ?? []) as StudioAvailabilityOverride[];
}

type WindowRow = {
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
};

// Single studio-wide weekly row for a weekday (or null). Used by the slot
// engine's OFF path so retained practitioner rows never make maybeSingle throw.
export async function getStudioWideDaySafe(
  supabase: SupabaseClient,
  studioId: string,
  dayOfWeek: number,
): Promise<WindowRow | null> {
  const scoped = await supabase
    .from("studio_availability_default")
    .select("is_open, open_time, close_time")
    .eq("studio_id", studioId)
    .eq("day_of_week", dayOfWeek)
    .is("practitioner_id", null)
    .maybeSingle();
  if (!scoped.error) return (scoped.data as WindowRow | null) ?? null;
  if (!isUndefinedColumn(scoped.error)) failClosed(scoped.error, "day");
  warnColumnAbsent("day");
  const legacy = await supabase
    .from("studio_availability_default")
    .select("is_open, open_time, close_time")
    .eq("studio_id", studioId)
    .eq("day_of_week", dayOfWeek)
    .maybeSingle();
  if (legacy.error) failClosed(legacy.error, "day");
  return (legacy.data as WindowRow | null) ?? null;
}

// Single studio-wide date override for a date (or null).
export async function getStudioWideOverrideDaySafe(
  supabase: SupabaseClient,
  studioId: string,
  effectiveDate: string,
): Promise<WindowRow | null> {
  const scoped = await supabase
    .from("studio_availability_overrides")
    .select("is_open, open_time, close_time")
    .eq("studio_id", studioId)
    .eq("effective_date", effectiveDate)
    .is("practitioner_id", null)
    .maybeSingle();
  if (!scoped.error) return (scoped.data as WindowRow | null) ?? null;
  if (!isUndefinedColumn(scoped.error)) failClosed(scoped.error, "override_day");
  warnColumnAbsent("override_day");
  const legacy = await supabase
    .from("studio_availability_overrides")
    .select("is_open, open_time, close_time")
    .eq("studio_id", studioId)
    .eq("effective_date", effectiveDate)
    .maybeSingle();
  if (legacy.error) failClosed(legacy.error, "override_day");
  return (legacy.data as WindowRow | null) ?? null;
}
