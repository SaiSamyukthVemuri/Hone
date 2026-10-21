import type { StudioAvailabilityDefault, StudioAvailabilityOverride } from "@/lib/types/database";
import { computeEffectiveOverrides, computeEffectiveWeek } from "@/lib/booking/practitioner-availability";

type Window = { is_open: boolean; open_time: string | null; close_time: string | null };
// The shared base types also cover pre-0135 reads; scoped rows add this column.
type ScopedDefault = StudioAvailabilityDefault & { practitioner_id?: string | null };
type ScopedOverride = StudioAvailabilityOverride & { practitioner_id?: string | null };

/**
 * SCH-004: the combined calendar has ONE tint, not one per practitioner. It
 * must not turn whichever personal row arrived last into studio-wide hours.
 * Reuse the existing per-scope precedence; show shared hours only when known
 * scopes agree. Otherwise leave the tint neutral and keep breaks visible.
 * This is display only: it never authorizes a booking or merges working hours.
 */
export function resolveCalendarDayAvailability(args: {
  date: string;
  dayOfWeek: number;
  defaults: ReadonlyArray<ScopedDefault>;
  overrides: ReadonlyArray<ScopedOverride>;
  capacityEnabled: boolean;
}): {
  availability: { isOpen: boolean; openTime: string | null; closeTime: string | null } | null;
  closedDay: boolean;
  hoursVary: boolean;
} {
  const { date, dayOfWeek, defaults, overrides, capacityEnabled } = args;
  // Missing practitioner_id is the pre-0135 studio-wide shape.
  const studioDefaults = defaults.filter((row) => row.practitioner_id == null);
  const studioOverrides = overrides.filter((row) => row.practitioner_id == null);
  const effective = (practitionerId: string | null): Window => {
    const personalDefaults = practitionerId ? defaults.filter((row) => row.practitioner_id === practitionerId) : null;
    const personalOverrides = practitionerId ? overrides.filter((row) => row.practitioner_id === practitionerId) : null;
    return computeEffectiveOverrides(studioOverrides, personalOverrides).find((row) => row.effective_date === date)
      ?? computeEffectiveWeek(studioDefaults, personalDefaults)[dayOfWeek];
  };
  const shared = effective(null);
  if (capacityEnabled) {
    const ids = new Set([...defaults, ...overrides].map((row) => row.practitioner_id).filter((id): id is string => id != null));
    for (const id of ids) {
      const personal = effective(id);
      const agrees = shared.is_open === personal.is_open && (!shared.is_open || (
        shared.open_time === personal.open_time && shared.close_time === personal.close_time
      ));
      if (!agrees) return { availability: null, closedDay: false, hoursVary: true };
    }
  }
  const configured = studioDefaults.some((row) => row.day_of_week === dayOfWeek)
    || studioOverrides.some((row) => row.effective_date === date);
  return {
    availability: configured ? { isOpen: shared.is_open, openTime: shared.open_time, closeTime: shared.close_time } : null,
    closedDay: !shared.is_open,
    hoursVary: false,
  };
}
