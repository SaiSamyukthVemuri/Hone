import { firstOfNextMonthString, firstOfPreviousMonthString, monthGridDates } from "@/lib/booking/month-grid";
import { addDays, startOfWeek } from "@/lib/booking/tz";
import type { DeskScheduleRow } from "@/lib/desk/read";

export type DeskView = "day" | "week" | "month";
export type DeskPerson = { id: string; name: string; color: string | null };
export const UNASSIGNED = "unassigned";

export function deskDays(date: string, view: DeskView): string[] {
  if (view === "day") return [date];
  if (view === "month") return monthGridDates(date);
  const start = startOfWeek(date);
  return Array.from({ length: 7 }, (_, index) => addDays(start, index));
}

export function shiftDeskDate(date: string, view: DeskView, direction: -1 | 1): string {
  if (view === "month") return direction < 0 ? firstOfPreviousMonthString(date) : firstOfNextMonthString(date);
  return addDays(date, direction * (view === "week" ? 7 : 1));
}

export function deskHref(date: string, view: DeskView): string {
  return `/desk?date=${date}&view=${view}`;
}

export function deskDateLabel(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat("en-US", { ...options, timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
}

export function deskRoster(active: { id: string; name: string }[], rows: DeskScheduleRow[]): DeskPerson[] {
  const people = new Map<string, DeskPerson>(active.map(p => [p.id, { ...p, color: null }]));
  for (const row of rows) {
    const id = row.practitionerId ?? UNASSIGNED;
    const person = people.get(id);
    if (!person) people.set(id, { id, name: row.practitionerName, color: row.practitionerColor });
    else if (!person.color) person.color = row.practitionerColor;
  }
  return [...people.values()];
}
