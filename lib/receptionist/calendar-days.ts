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
 * Every local calendar date that the interval [startIso, endIso) touches in
 * `timeZone`. The end is exclusive, so a closure ending at local midnight does
 * not count for the next day. Bounded at 400 days.
 */
export function localDaysOverlapped(startIso: string, endIso: string, timeZone: string): string[] {
  const first = localDateKey(startIso, timeZone);
  const endMs = Date.parse(endIso);
  if (!(endMs > Date.parse(startIso))) return [first];
  const last = localDateKey(new Date(endMs - 1).toISOString(), timeZone);
  const out: string[] = [];
  for (const k of localCalendarDays(first, 400)) {
    out.push(k);
    if (k >= last) break;
  }
  return out;
}

/** The display label of a local calendar date, independent of any offset. */
export function localDateLabel(key: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "short", day: "numeric" }).format(
    new Date(`${key}T12:00:00Z`),
  );
}
