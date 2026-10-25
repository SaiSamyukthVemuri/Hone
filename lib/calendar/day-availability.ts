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
  /** IDs from the authenticated, active same-studio practitioner census. */
  activePractitionerIds: ReadonlyArray<string>;
}): {
  availability: { isOpen: boolean; openTime: string | null; closeTime: string | null } | null;
  closedDay: boolean;
  hoursVary: boolean;
} {
  const { date, dayOfWeek, defaults, overrides, capacityEnabled } = args;
  // Missing practitioner_id is the pre-0135 studio-wide shape.
  const effective = (practitionerId: string | null): Window =>
    effectiveWindow(date, dayOfWeek, defaults, overrides, practitionerId);
  const ids = [...new Set(args.activePractitionerIds)];
  if (capacityEnabled && ids.length === 0) {
    return { availability: null, closedDay: false, hoursVary: false };
  }
  // Compare actual bookable practitioners, not retained history or a fictitious
  // extra studio practitioner. An active ID with no rows still inherits.
  const commonId = capacityEnabled ? ids[0] : null;
  const shared = effective(commonId);
  if (capacityEnabled) {
    for (const id of ids.slice(1)) {
      const personal = effective(id);
      const agrees = shared.is_open === personal.is_open && (!shared.is_open || (
        shared.open_time === personal.open_time && shared.close_time === personal.close_time
      ));
      if (!agrees) return { availability: null, closedDay: false, hoursVary: true };
    }
  }
  const configured = windowConfigured(date, dayOfWeek, defaults, overrides, commonId);
  return {
    availability: configured ? { isOpen: shared.is_open, openTime: shared.open_time, closeTime: shared.close_time } : null,
    closedDay: !shared.is_open,
    hoursVary: false,
  };
}

// The same per-scope precedence as above, for ONE practitioner: a personal
// date override, else a studio date override, else the personal weekday row,
// else the studio weekday row.
function effectiveWindow(
  date: string,
  dayOfWeek: number,
  defaults: ReadonlyArray<ScopedDefault>,
  overrides: ReadonlyArray<ScopedOverride>,
  practitionerId: string | null,
): Window {
  const studioDefaults = defaults.filter((row) => row.practitioner_id == null);
  const studioOverrides = overrides.filter((row) => row.practitioner_id == null);
  const personalDefaults = practitionerId ? defaults.filter((row) => row.practitioner_id === practitionerId) : null;
  const personalOverrides = practitionerId ? overrides.filter((row) => row.practitioner_id === practitionerId) : null;
  return computeEffectiveOverrides(studioOverrides, personalOverrides).find((row) => row.effective_date === date)
    ?? computeEffectiveWeek(studioDefaults, personalDefaults)[dayOfWeek];
}

function windowConfigured(
  date: string,
  dayOfWeek: number,
  defaults: ReadonlyArray<ScopedDefault>,
  overrides: ReadonlyArray<ScopedOverride>,
  practitionerId: string | null,
): boolean {
  return defaults.some((row) => row.practitioner_id == null && row.day_of_week === dayOfWeek)
    || overrides.some((row) => row.practitioner_id == null && row.effective_date === date)
    || (practitionerId != null && (
      defaults.some((row) => row.practitioner_id === practitionerId && row.day_of_week === dayOfWeek)
      || overrides.some((row) => row.practitioner_id === practitionerId && row.effective_date === date)
    ));
}

/**
 * HON-48 team day view: ONE practitioner's own hours for one date, so each
 * practitioner column can grey that person's off-hours. Display only, like
 * the shared tint above; booking authority stays in the booking engine.
 * `availability` is null when no row applies (no tint, never a guessed state).
 */
export function resolvePractitionerDayAvailability(args: {
  date: string;
  dayOfWeek: number;
  defaults: ReadonlyArray<ScopedDefault>;
  overrides: ReadonlyArray<ScopedOverride>;
  practitionerId: string;
}): {
  availability: { isOpen: boolean; openTime: string | null; closeTime: string | null } | null;
  closedDay: boolean;
} {
  const { date, dayOfWeek, defaults, overrides, practitionerId } = args;
  const window = effectiveWindow(date, dayOfWeek, defaults, overrides, practitionerId);
  const configured = windowConfigured(date, dayOfWeek, defaults, overrides, practitionerId);
  return {
    availability: configured ? { isOpen: window.is_open, openTime: window.open_time, closeTime: window.close_time } : null,
    closedDay: !window.is_open,
  };
}
