// STUDIO-READY-02d (#824): local calendar arithmetic for the front-desk
// schedule.

/**
 * `count` consecutive local calendar dates (YYYY-MM-DD), starting at `startKey`.
 * This is pure calendar arithmetic on the date itself, never 24-hour steps on an
 * instant: across a daylight-saving change, an instant plus 24 hours can land
 * on the same local date and silently drop a day.
 */
export function localCalendarDays(startKey: string, count: number): string[] {
  const [y, m, d] = startKey.split("-").map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(y, m - 1, d + i)).toISOString().slice(0, 10));
}

/** The local calendar date (YYYY-MM-DD) of an instant in `timeZone`. */
export function localDateKey(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(iso),
  );
}

/**
 * The displayed local dates (`days`, ascending YYYY-MM-DD) that the interval
 * [startIso, endIso) touches in `timeZone`. The end is exclusive, so a closure
 * ending at local midnight does not count for the next day.
 *
 * It intersects with the DISPLAYED days rather than walking from the closure's
 * start, so a closure of any length is handled, including one that began long
 * before the window (Codex P2 4243919021 on #845).
 */
export function localDaysOverlapped(startIso: string, endIso: string, timeZone: string, days: readonly string[]): string[] {
  const first = localDateKey(startIso, timeZone);
  const endMs = Date.parse(endIso);
  const last = endMs > Date.parse(startIso) ? localDateKey(new Date(endMs - 1).toISOString(), timeZone) : first;
  return days.filter((k) => k >= first && k <= last);
}

/** The display label of a local calendar date, independent of any offset. */
export function localDateLabel(key: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(
    new Date(`${key}T12:00:00Z`),
  );
}
