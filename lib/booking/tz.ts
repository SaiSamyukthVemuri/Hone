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
  // wrong by exactly the tz offset at that instant; correct it in one pass.
  const naive = new Date(`${localDate}T${localTime}:00.000Z`);
  const offsetMin = tzOffsetMinutes(naive, tz);
  return new Date(naive.getTime() - offsetMin * 60_000);
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
