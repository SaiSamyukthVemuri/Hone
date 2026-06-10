// Zero-dependency timezone helpers.
// All times in the DB are UTC. The UI displays in the studio's IANA timezone.

function partsInTz(date: Date, tz: string): Record<string, string> {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    weekday: "short",
  });
  const out: Record<string, string> = {};
  for (const part of f.formatToParts(date)) {
    out[part.type] = part.value;
  }
  return out;
}

// Returns the UTC offset (in minutes) of `tz` at the moment described by `date`.
// Positive when the zone is ahead of UTC. America/Toronto in summer = -240.
export function tzOffsetMinutes(date: Date, tz: string): number {
  const parts = partsInTz(date, tz);
  let hour = Number(parts.hour);
  if (hour === 24) hour = 0;
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - date.getTime()) / 60000;
}

// Converts a local wall-clock date+time in `tz` into a UTC Date instance.
// localDate: "YYYY-MM-DD", localTime: "HH:MM" (24h).
export function utcInstantFromLocal(
  localDate: string,
  localTime: string,
  tz: string,
): Date {
  // First read: pretend the local string is UTC. The resulting instant is
  // wrong by exactly the tz offset at that instant; correct it. A single
  // correction pass is not enough when the naive and corrected instants
  // straddle a DST transition: the offset sampled at the naive instant is
  // the pre-transition one, so the corrected instant lands an hour off
  // (PR #184; Toronto 2026-03-08 03:30 was stored as 08:30Z and rendered
  // back as 04:30). Re-sample the offset at the corrected instant and
  // re-apply when it differs. Edge conventions, pinned by tests:
  //   * fall-back ambiguous times (the repeated 01:xx hour) resolve to
  //     the FIRST, pre-transition occurrence, same as before this fix;
  //   * spring-forward nonexistent times (the skipped 02:xx hour) map to
  //     the instant one hour BEFORE the wall-clock string (the input
  //     does not exist locally, so no convention can round-trip it).
  const naive = new Date(`${localDate}T${localTime}:00.000Z`);
  const firstOffsetMin = tzOffsetMinutes(naive, tz);
  let corrected = naive.getTime() - firstOffsetMin * 60_000;
  const secondOffsetMin = tzOffsetMinutes(new Date(corrected), tz);
  if (secondOffsetMin !== firstOffsetMin) {
    corrected = naive.getTime() - secondOffsetMin * 60_000;
  }
  return new Date(corrected);
}

// Renders a UTC Date as the local YYYY-MM-DD in `tz`.
export function localDateString(d: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(d);
}

// Renders a UTC Date as the local HH:MM in `tz` (24h).
export function localTimeString(d: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return f.format(d);
}

// 12-hour public-facing time formatter (e.g. "9:00 AM" / "1:30 PM").
// Use this on every CLIENT-FACING surface: public booking + reschedule
// slot labels AND every email template that renders an appointment
// time. Practitioner-facing surfaces (calendar grid, dashboard roster,
// owner notification email) stay on the 24h localTimeString helper so
// the column header heuristics + tight calendar rows are not
// disturbed. Bug context: PR #157 patch corrected the
// confirmation/reminder/postcare/cancellation client emails which
// previously rendered "11 to 12" (24h) for an 11:00-12:00 booking
// because they were calling the 24h helper despite being client-
// facing.
export function localTimeString12h(d: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  return f.format(d);
}

// "Tuesday, June 3, 2026"-style long date for transactional templates
// (email day headers, SMS confirmation/reminder body). The email
// templates in lib/email/templates/*.ts already render this exact
// format via a private local helper; promoting it here so SMS
// templates can reuse the same Intl recipe without duplication. The
// locale is en-US to match the existing email day labels for
// continuity (en-CA orders day-month identically here, but en-US is
// the historical choice in the email path).
export function localLongDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(d);
}

// 0 = Sunday, 6 = Saturday — matches JS Date getDay() in UTC, but evaluated
// against the studio's local clock.
export function localDayOfWeek(d: Date, tz: string): number {
  const dateStr = localDateString(d, tz);
  // Treat dateStr as a UTC date (it lines up with the start of that local day
  // for the purposes of "which weekday is this").
  const asUtc = new Date(`${dateStr}T12:00:00Z`);
  return asUtc.getUTCDay();
}

// Number of minutes since local midnight on the given local date.
// Used to compare "HH:MM" wall-clock strings against availability windows.
export function localMinutesSinceMidnight(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

export function minutesToHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// Adds n calendar days to a YYYY-MM-DD string and returns YYYY-MM-DD.
export function addDays(dateStr: string, n: number): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Returns the YYYY-MM-DD of the Sunday on or before `dateStr` (treating dates
// as local; weeks start Sunday for now).
export function startOfWeek(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function todayInTz(tz: string): string {
  return localDateString(new Date(), tz);
}
