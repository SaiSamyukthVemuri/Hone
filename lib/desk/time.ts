// Studio-clock helpers for the desk. A receptionist cannot read the studio row, so the studio's IANA zone comes from
// the database (the schedule's studio_timezone) and every time the desk shows is in THAT zone, never the device's
// clock. Pure: no I/O.

/** True when Intl accepts the zone string. The formatters below fall back to UTC when it does not. */
export function isUsableTimeZone(tz: string | null | undefined): boolean {
  if (typeof tz !== "string" || tz.length === 0) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const CLOCK_FALLBACK_NOTICE =
  "This studio's clock could not be read, so times on this page are shown in UTC. Check them with the studio before relying on them.";

function format(iso: string, tz: string, opts: Intl.DateTimeFormatOptions): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("en-US", { ...opts, timeZone: "UTC" }).format(new Date(ms));
  }
}

/** "Mon, Mar 4, 3:00 PM" in the studio zone (UTC if the zone is unusable). */
export function formatStudioDateTime(iso: string, tz: string): string {
  return format(iso, tz, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export function formatStudioTime(iso: string, tz: string): string {
  return format(iso, tz, { hour: "numeric", minute: "2-digit" });
}
