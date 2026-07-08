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

// Some ICU builds resolve `hour12: false` to the h24 hour cycle and
// render hour 0 as "24" ("24:30" for half past midnight); others
// resolve it to h23 and render "00:30" (PR #185; surfaced by the PR
// #184 CI run, whose ICU emitted "24:30" where dev machines emitted
// "00:30"). tzOffsetMinutes normalizes the same quirk numerically;
// this normalizes the rendered string so callers always get HH from
// 00 to 23.
function normalizeHour24(time: string): string {
  return time.startsWith("24:") ? `00:${time.slice(3)}` : time;
}

// Renders a UTC Date as the local HH:MM in `tz` (24h, HH always 00-23).
export function localTimeString(d: Date, tz: string): string {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return normalizeHour24(f.format(d));
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

// Studio time-format preference (migration 0109). Practitioner-facing surfaces
// pick 12h vs 24h from this; client-facing surfaces stay 12h regardless.
export type TimeFormat = "12h" | "24h";

// Resolve a studio's preference, DEFAULTING TO 12h when unset. This covers
// pre-migration studios (loaded via `select *`, so the column is simply absent)
// and any null — so nothing breaks before 0109 is applied, and the app default
// is 12h with no studio special-cased.
export function resolveTimeFormat(
  studio: { time_format_preference?: string | null } | null | undefined,
): TimeFormat {
  return studio?.time_format_preference === "24h" ? "24h" : "12h";
}

// Format an instant in `tz` using a studio's chosen DISPLAY format. Timezone
// handling is unchanged — this only selects 12h vs 24h. Use on PRACTITIONER-
// FACING surfaces (calendar/dashboard/availability). Do NOT use for machine
// values (grid positioning math, <input type="time"> values) — those stay 24h.
export function formatTimeForStudio(
  d: Date,
  tz: string,
  format: TimeFormat,
): string {
  return format === "24h" ? localTimeString(d, tz) : localTimeString12h(d, tz);
}

// Format a naive local wall-clock "HH:MM" (24h machine value — e.g. from a
// calendar drag / minutesToHHMM) into a DISPLAY label per the studio
// preference: "1:00 PM" (12h) or "13:00" (24h). No timezone is applied because
// the value is already local wall-clock; the underlying machine value is never
// mutated. Returns the input unchanged if it isn't a valid HH:MM.
export function formatClockLabel(hhmm: string, format: TimeFormat): string {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return hhmm;
  const h = Number(m[1]);
  const min = m[2];
  if (!Number.isFinite(h) || h < 0 || h > 23) return hhmm;
  if (format === "24h") return `${String(h).padStart(2, "0")}:${min}`;
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${min} ${period}`;
}

// Human-readable date label from a "YYYY-MM-DD" string. Rendered in UTC so a
// bare (timezone-less) date never shifts. "2026-07-09" → "Jul 9, 2026".
export function formatLocalDateLabel(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(d);
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
