import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  StudioAvailabilityDefault,
  StudioAvailabilityOverride,
} from "@/lib/types/database";

// STUDIO-WIDE availability loaders (PR B Part 3A).
//
// The rollback lifecycle: capacity enabled -> per-practitioner rows created ->
// capacity disabled (rows RETAINED for future reactivation), means a flag-OFF
// studio can hold both studio-wide (practitioner_id IS NULL) AND practitioner
// rows. Every OFF read path (settings page, slot generation) and the flag-ON
// Studio-default scope MUST see ONLY the studio-wide rows, or a weekday/date
// would resolve to multiple rows (breaking the single-row UI + slot maybeSingle).
//
// These loaders query `practitioner_id IS NULL` (0135, hosted). Any error FAILS
// CLOSED: there is no unscoped retry, because an unscoped read is exactly the
// multi-row result this module exists to prevent. We never log query contents
// or row data, only a safe operational code.

type PgErr = { code?: string | null } | null | undefined;

function failClosed(error: PgErr, what: string): never {
  // Safe operational code only, never the raw message (which can echo data).
  throw new Error(`availability_read_failed:${what}:${error?.code ?? "unknown"}`);
}

export async function getStudioWideDefaultsSafe(
  supabase: SupabaseClient,
  studioId: string,
): Promise<StudioAvailabilityDefault[]> {
  const { data, error } = await supabase
    .from("studio_availability_default")
    .select("*")
    .eq("studio_id", studioId)
    .is("practitioner_id", null)
    .order("day_of_week");
  if (error) failClosed(error, "defaults");
  return (data ?? []) as StudioAvailabilityDefault[];
}

export async function getStudioWideOverridesSafe(
  supabase: SupabaseClient,
  studioId: string,
  startDate: string,
  endDate: string,
): Promise<StudioAvailabilityOverride[]> {
  const { data, error } = await supabase
    .from("studio_availability_overrides")
    .select("*")
    .eq("studio_id", studioId)
    .is("practitioner_id", null)
    .gte("effective_date", startDate)
    .lte("effective_date", endDate)
    .order("effective_date");
  if (error) failClosed(error, "overrides");
  return (data ?? []) as StudioAvailabilityOverride[];
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
  const { data, error } = await supabase
    .from("studio_availability_default")
    .select("is_open, open_time, close_time")
    .eq("studio_id", studioId)
    .eq("day_of_week", dayOfWeek)
    .is("practitioner_id", null)
    .maybeSingle();
  if (error) failClosed(error, "day");
  return (data as WindowRow | null) ?? null;
}

// Single studio-wide date override for a date (or null).
export async function getStudioWideOverrideDaySafe(
  supabase: SupabaseClient,
  studioId: string,
  effectiveDate: string,
): Promise<WindowRow | null> {
  const { data, error } = await supabase
    .from("studio_availability_overrides")
    .select("is_open, open_time, close_time")
    .eq("studio_id", studioId)
    .eq("effective_date", effectiveDate)
    .is("practitioner_id", null)
    .maybeSingle();
  if (error) failClosed(error, "override_day");
  return (data as WindowRow | null) ?? null;
}
