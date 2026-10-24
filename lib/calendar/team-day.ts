import type { StudioAvailabilityDefault, StudioAvailabilityOverride, StudioTimedBlock } from "@/lib/types/database";
import type {
  AppointmentWithPractitionerColor,
  RecurringBreakOccurrenceWithRule,
} from "@/lib/booking/queries";
import { localDateString } from "@/lib/booking/tz";
import { resolvePractitionerColor } from "@/lib/practitioner-colors";
import { resolvePractitionerDayAvailability } from "@/lib/calendar/day-availability";

// HON-48 team day view: one column per working practitioner for one studio-local
// date. Pure and display only. It partitions rows the calendar page ALREADY
// loaded with its existing studio-scoped reads; it runs no query, so it cannot
// widen which schedules a viewer sees, and it never authorizes a booking.

export type TeamDayPractitioner = {
  id: string;
  display_name: string;
  color: string | null;
};

export type TeamDayColumn = {
  // The practitioner the column belongs to. Rows whose practitioner is not in
  // the active census get a column of their own rather than being dropped or
  // folded into someone else's; null is the column for appointments with no
  // practitioner at all (rows from before practitioner capacity).
  practitionerId: string | null;
  name: string;
  headerBgClass: string;
  headerTextClass: string;
  colorLabel: string;
  // False for a practitioner outside the active census (inactive or removed)
  // who still holds appointments on this date.
  active: boolean;
  appts: AppointmentWithPractitionerColor[];
  timedBlocks: StudioTimedBlock[];
  recurringBreaks: RecurringBreakOccurrenceWithRule[];
  availability: { isOpen: boolean; openTime: string | null; closeTime: string | null } | null;
  closedDay: boolean;
};

export type TeamDay = {
  columns: TeamDayColumn[];
  // Active practitioners who are off all day and hold no appointment. They
  // get no column; the page names them so nobody looks absent by accident.
  notWorking: Array<{ practitionerId: string; name: string }>;
};

type ScopedDefault = StudioAvailabilityDefault & { practitioner_id?: string | null };
type ScopedOverride = StudioAvailabilityOverride & { practitioner_id?: string | null };

export function buildTeamDay(args: {
  date: string;
  dayOfWeek: number;
  tz: string;
  // Active, same-studio practitioners in display order.
  practitioners: ReadonlyArray<TeamDayPractitioner>;
  appointments: ReadonlyArray<AppointmentWithPractitionerColor>;
  timedBlocks: ReadonlyArray<StudioTimedBlock>;
  recurringBreaks: ReadonlyArray<RecurringBreakOccurrenceWithRule>;
  defaults: ReadonlyArray<ScopedDefault>;
  overrides: ReadonlyArray<ScopedOverride>;
}): TeamDay {
  const { date, dayOfWeek, tz } = args;
  const onDate = (iso: string) => localDateString(new Date(iso), tz) === date;
  // Same display rule as the week grid: cancelled appointments free their slot
  // and are hidden; confirmed, completed and no-show stay visible.
  const appts = args.appointments.filter((a) => a.status !== "cancelled" && onDate(a.starts_at));
  const timedBlocks = args.timedBlocks.filter((b) => onDate(b.starts_at));
  const recurringBreaks = args.recurringBreaks.filter((b) => onDate(b.starts_at));

  // A NULL practitioner_id block or break is studio-wide: it applies to every
  // column. A scoped one belongs to its own practitioner's column only.
  const forPractitioner = <T extends { practitioner_id: string | null }>(rows: T[], id: string | null) =>
    rows.filter((row) => row.practitioner_id == null || row.practitioner_id === id);

  const column = (
    id: string | null,
    name: string,
    color: string | null | undefined,
    active: boolean,
  ): TeamDayColumn => {
    const palette = resolvePractitionerColor(color);
    const window = active && id != null
      ? resolvePractitionerDayAvailability({ date, dayOfWeek, defaults: args.defaults, overrides: args.overrides, practitionerId: id })
      : { availability: null, closedDay: false };
    return {
      practitionerId: id,
      name,
      headerBgClass: palette.bg,
      headerTextClass: palette.text,
      colorLabel: palette.label,
      active,
      appts: appts.filter((a) => a.practitioner_id === id),
      timedBlocks: forPractitioner(timedBlocks, id),
      recurringBreaks: forPractitioner(recurringBreaks, id),
      availability: window.availability,
      closedDay: window.closedDay,
    };
  };

  const columns: TeamDayColumn[] = [];
  const notWorking: TeamDay["notWorking"] = [];
  const listed = new Set<string>();
  for (const p of args.practitioners) {
    if (listed.has(p.id)) continue;
    listed.add(p.id);
    const name = p.display_name?.trim() || "Practitioner";
    const c = column(p.id, name, p.color, true);
    // Unknown hours (no row applies) still get a column: never hide someone
    // because their schedule was not configured.
    const working = c.availability === null || c.availability.isOpen || c.appts.length > 0;
    if (working) columns.push(c);
    else notWorking.push({ practitionerId: p.id, name });
  }

  // Appointments held by someone outside the active census stay visible, one
  // column per such practitioner, named from the appointment's own join.
  const extra = new Map<string, { name: string; color: string | null }>();
  for (const a of appts) {
    if (a.practitioner_id == null || listed.has(a.practitioner_id) || extra.has(a.practitioner_id)) continue;
    extra.set(a.practitioner_id, {
      name: a.practitioner?.display_name?.trim() || "Former practitioner",
      color: a.practitioner?.color ?? null,
    });
  }
  for (const [id, p] of extra) columns.push(column(id, p.name, p.color, false));
  if (appts.some((a) => a.practitioner_id == null)) {
    columns.push(column(null, "Unassigned", null, false));
  }

  return { columns, notWorking };
}
