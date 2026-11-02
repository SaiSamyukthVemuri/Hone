// Studio-clock helpers for the desk. A receptionist cannot read the studio row, so the studio's
// IANA zone comes from the database (receptionist_studio_timezone / the schedule's studio_timezone)
// and every date or time the desk shows or accepts is in THAT zone, never the device's clock.
// Pure: no I/O.

const PARTS = ["year", "month", "day", "hour", "minute"] as const;

function formatter(tz: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function partsOf(ms: number, tz: string): Record<(typeof PARTS)[number], number> {
  const out = {} as Record<(typeof PARTS)[number], number>;
  for (const p of formatter(tz).formatToParts(new Date(ms))) {
    if ((PARTS as readonly string[]).includes(p.type)) out[p.type as (typeof PARTS)[number]] = Number(p.value);
  }
  return out;
}

/** The local clock reading of an instant, as the pieces the booking form uses. */
export function localParts(iso: string, tz: string): { date: string; time: string } | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  try {
    const p = partsOf(ms, tz);
    const two = (n: number) => String(n).padStart(2, "0");
    return { date: `${p.year}-${two(p.month)}-${two(p.day)}`, time: `${two(p.hour)}:${two(p.minute)}` };
  } catch {
    return null;
  }
}

/**
 * A studio-local date ("YYYY-MM-DD") and time ("HH:MM") as a UTC instant (ISO), or null when the
 * input is malformed or names a local time that does not exist (a daylight-saving gap). An
 * ambiguous time (a daylight-saving overlap) resolves to its first occurrence.
 */
export function studioLocalToInstant(date: string, time: string, tz: string): string | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) return null;
  const [y, mo, da, h, mi] = [d[1], d[2], d[3], t[1], t[2]].map(Number);
  if (mo < 1 || mo > 12 || da < 1 || da > 31 || h > 23 || mi > 59) return null;
  const wanted = Date.UTC(y, mo - 1, da, h, mi);
  const check = new Date(wanted); // a day the month does not have (Feb 31) would roll over silently
  if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== da) return null;
  try {
    let guess = wanted;
    for (let i = 0; i < 3; i += 1) {
      const p = partsOf(guess, tz);
      const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
      const diff = shown - wanted;
      if (diff === 0) break;
      guess -= diff;
    }
    const back = partsOf(guess, tz);
    if (Date.UTC(back.year, back.month - 1, back.day, back.hour, back.minute) !== wanted) return null;
    // Overlap: step back an hour if that is the same local reading (first occurrence).
    const earlier = guess - 3_600_000;
    const e = partsOf(earlier, tz);
    if (Date.UTC(e.year, e.month - 1, e.day, e.hour, e.minute) === wanted) guess = earlier;
    return new Date(guess).toISOString();
  } catch {
    return null;
  }
}

/** "Mon, Mar 4, 3:00 PM" in the studio zone (falls back to UTC if the zone is unusable). */
export function formatStudioDateTime(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(ms));
  }
}

export function formatStudioTime(iso: string, tz: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: tz }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(ms));
  }
}
