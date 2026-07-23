import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  StudioAvailabilityDefault,
  StudioAvailabilityOverride,
} from "@/lib/types/database";
import {
  getStudioWideDefaultsSafe,
  getStudioWideOverridesSafe,
} from "@/lib/booking/studio-wide-availability";

// Server-side per-practitioner availability model (PR B Part 2). Everything
// here is reached ONLY when studio.practitioner_capacity_enabled === true; the
// flag-OFF path continues to use the studio-wide queries in lib/booking/queries
// and never references practitioner_id. Studio-wide rows carry
// practitioner_id IS NULL; a practitioner row (practitioner_id = P) overrides
// the studio-wide fallback for P only.

export type ScheduleScope =
  | { kind: "studio"; practitionerId: null }
  | { kind: "practitioner"; practitionerId: string };

export type ScopePractitioner = {
  id: string;
  display_name: string;
  color: string;
  role: string;
};

// The effective schedule for one weekday, with its SOURCE and whether the
// selected practitioner has a persisted row (so the UI never shows an inherited
// value as if it were custom).
export type EffectiveDay = {
  day_of_week: number;
  is_open: boolean;
  open_time: string | null; // "HH:MM"
  close_time: string | null; // "HH:MM"
  source: "studio_default" | "practitioner";
  hasCustom: boolean;
};

export type EffectiveOverride = {
  effective_date: string;
  is_open: boolean;
  open_time: string | null;
  close_time: string | null;
  note: string | null;
  source: "studio_override" | "practitioner_override";
  hasCustom: boolean; // the selected practitioner has a persisted row for this date
};

const hhmm = (t: string | null): string | null => (t ? t.slice(0, 5) : null);

/** Active practitioners for the scope selector (owner first, then by name). */
export async function getActivePractitioners(
  supabase: SupabaseClient,
  studioId: string,
): Promise<ScopePractitioner[]> {
  const { data, error } = await supabase
    .from("practitioners")
    .select("id, display_name, color, role")
    .eq("studio_id", studioId)
    .eq("active", true)
    .order("role", { ascending: true }) // 'owner' < 'practitioner'
    .order("display_name", { ascending: true });
  if (error) throw new Error(`Failed to load practitioners: ${error.message}`);
  return (data ?? []) as ScopePractitioner[];
}

/**
 * Resolve a requested practitioner id (e.g. from the URL) to a valid scope.
 * NEVER trusts the id: it must be an active practitioner of THIS studio.
 * Anything else (missing, malformed, inactive, cross-studio) falls back to the
 * studio scope — without revealing whether the id belongs to another studio.
 */
export function resolveScope(
  requested: string | null | undefined,
  activePractitioners: ScopePractitioner[],
): ScheduleScope {
  if (!requested) return { kind: "studio", practitionerId: null };
  const match = activePractitioners.find((p) => p.id === requested);
  return match
    ? { kind: "practitioner", practitionerId: match.id }
    : { kind: "studio", practitionerId: null };
}

/**
 * Studio-wide weekly rows (practitioner_id IS NULL). Delegates to the
 * migration-order-safe loader so a rolled-back studio (retained practitioner
 * rows) never surfaces mixed rows here.
 */
export async function studioWideDefaults(
  supabase: SupabaseClient,
  studioId: string,
): Promise<StudioAvailabilityDefault[]> {
  return getStudioWideDefaultsSafe(supabase, studioId);
}

async function practitionerDefaults(
  supabase: SupabaseClient,
  studioId: string,
  practitionerId: string,
): Promise<StudioAvailabilityDefault[]> {
  const { data, error } = await supabase
    .from("studio_availability_default")
    .select("*")
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .order("day_of_week");
  if (error)
    throw new Error(`Failed to load practitioner hours: ${error.message}`);
  return (data ?? []) as StudioAvailabilityDefault[];
}

export async function studioWideOverrides(
  supabase: SupabaseClient,
  studioId: string,
  startDate: string,
  endDate: string,
): Promise<StudioAvailabilityOverride[]> {
  return getStudioWideOverridesSafe(supabase, studioId, startDate, endDate);
}

async function practitionerOverrides(
  supabase: SupabaseClient,
  studioId: string,
  practitionerId: string,
  startDate: string,
  endDate: string,
): Promise<StudioAvailabilityOverride[]> {
  const { data, error } = await supabase
    .from("studio_availability_overrides")
    .select("*")
    .eq("studio_id", studioId)
    .eq("practitioner_id", practitionerId)
    .gte("effective_date", startDate)
    .lte("effective_date", endDate)
    .order("effective_date");
  if (error)
    throw new Error(`Failed to load practitioner overrides: ${error.message}`);
  return (data ?? []) as StudioAvailabilityOverride[];
}

/**
 * Effective weekly schedule for a scope. For the studio scope it is just the
 * studio-wide rows. For a practitioner scope, a persisted practitioner row wins
 * over the studio-wide fallback for that weekday; otherwise the day inherits the
 * studio default (source = studio_default, hasCustom = false).
 */
export function computeEffectiveWeek(
  studioDefaults: StudioAvailabilityDefault[],
  practitionerDefaults: StudioAvailabilityDefault[] | null,
): EffectiveDay[] {
  const studioByDow = new Map(studioDefaults.map((r) => [r.day_of_week, r]));
  const pracByDow = new Map(
    (practitionerDefaults ?? []).map((r) => [r.day_of_week, r]),
  );
  const week: EffectiveDay[] = [];
  for (let dow = 0; dow < 7; dow++) {
    const custom = pracByDow.get(dow);
    if (practitionerDefaults && custom) {
      week.push({
        day_of_week: dow,
        is_open: custom.is_open,
        open_time: hhmm(custom.open_time),
        close_time: hhmm(custom.close_time),
        source: "practitioner",
        hasCustom: true,
      });
    } else {
      const s = studioByDow.get(dow);
      week.push({
        day_of_week: dow,
        is_open: s?.is_open ?? false,
        open_time: hhmm(s?.open_time ?? null),
        close_time: hhmm(s?.close_time ?? null),
        source: "studio_default",
        hasCustom: false,
      });
    }
  }
  return week;
}

/**
 * Effective overrides for a scope: the union of studio-wide and (for a
 * practitioner scope) that practitioner's overrides, keyed by date. A
 * practitioner date override wins over the studio date override for that date.
 */
export function computeEffectiveOverrides(
  studioOverrides: StudioAvailabilityOverride[],
  practitionerOverrides: StudioAvailabilityOverride[] | null,
): EffectiveOverride[] {
  const byDate = new Map<string, EffectiveOverride>();
  for (const s of studioOverrides) {
    byDate.set(s.effective_date, {
      effective_date: s.effective_date,
      is_open: s.is_open,
      open_time: hhmm(s.open_time),
      close_time: hhmm(s.close_time),
      note: s.note ?? null,
      source: "studio_override",
      hasCustom: false,
    });
  }
  for (const p of practitionerOverrides ?? []) {
    // Practitioner override wins over the studio override for the same date.
    byDate.set(p.effective_date, {
      effective_date: p.effective_date,
      is_open: p.is_open,
      open_time: hhmm(p.open_time),
      close_time: hhmm(p.close_time),
      note: p.note ?? null,
      source: "practitioner_override",
      hasCustom: true,
    });
  }
  return [...byDate.values()].sort((a, b) =>
    a.effective_date < b.effective_date ? -1 : 1,
  );
}

/** Load everything the owner UI needs for the selected scope, in parallel. */
export async function loadScopedAvailability(
  supabase: SupabaseClient,
  studioId: string,
  scope: ScheduleScope,
  startDate: string,
  endDate: string,
): Promise<{ week: EffectiveDay[]; overrides: EffectiveOverride[] }> {
  const [studioDefaults, studioOverrides] = await Promise.all([
    studioWideDefaults(supabase, studioId),
    studioWideOverrides(supabase, studioId, startDate, endDate),
  ]);
  if (scope.kind === "studio") {
    return {
      week: computeEffectiveWeek(studioDefaults, null),
      overrides: computeEffectiveOverrides(studioOverrides, null),
    };
  }
  const [pDefaults, pOverrides] = await Promise.all([
    practitionerDefaults(supabase, studioId, scope.practitionerId),
    practitionerOverrides(supabase, studioId, scope.practitionerId, startDate, endDate),
  ]);
  return {
    week: computeEffectiveWeek(studioDefaults, pDefaults),
    overrides: computeEffectiveOverrides(studioOverrides, pOverrides),
  };
}
