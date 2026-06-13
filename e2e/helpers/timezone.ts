// Time-of-day independence for the browser E2E fixture (post-PR #238
// fix). The specs book through the REAL public flow and then assert
// the appointment on the Dashboard "Today" roster, so the seeded
// studio's LOCAL day must still have bookable slots whenever the run
// starts. A fixed America/Toronto zone broke nightly: after 21:30
// Toronto the last 06:00-22:00 slot was gone, the booking correctly
// rolled to tomorrow, and every Today assertion failed (first seen on
// the PR #238 post-merge run). This returns a fixed-offset zone where
// the studio clock reads ~09:00 right now, so the local day ahead is
// full of slots at any real-world hour. Note: IANA Etc/GMT naming is
// POSIX-inverted (Etc/GMT-5 means UTC+5); both Postgres and Intl
// accept these zone names.
//
// Dependency-free ON PURPOSE: the unit suite imports this directly,
// and anything that pulls in local-env.ts would throw its local-only
// guard in the fast CI lane (whose env points at the hosted stack).
export function timezoneWithLocalMorning(now: Date = new Date()): string {
  let offset = 9 - now.getUTCHours();
  if (offset > 12) offset -= 24;
  if (offset < -11) offset += 24;
  return offset >= 0 ? `Etc/GMT-${offset}` : `Etc/GMT+${-offset}`;
}
