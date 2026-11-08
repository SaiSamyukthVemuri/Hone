// HON-48: the team day view's column geometry, in one place so the page and
// its tests share one rule.
//
// The columns FILL the available width: `minmax(MIN, 1fr)`. One selected
// practitioner is a single day schedule that uses the whole calendar area (no
// narrow column inside an empty container); several share the width equally. A
// column never gets narrower than TEAM_DAY_COLUMN_MIN_WIDTH_REM, so once the
// selected practitioners no longer fit, the grid grows past the box and scrolls
// sideways inside the scroll box instead of squeezing every column unreadable.
// This replaces the fixed 13rem track (which left a lone column compact beside a
// large empty area); the earlier `minmax(9rem, 1fr)` problem was only its minimum.

export const TEAM_DAY_RAIL_PX = 60;
/** The narrowest a practitioner column may get before the grid scrolls sideways. */
export const TEAM_DAY_COLUMN_MIN_WIDTH_REM = 12;

export function teamDayGridTemplate(columnCount: number): string {
  const n = Number.isFinite(columnCount) ? Math.max(1, Math.floor(columnCount)) : 1;
  return `${TEAM_DAY_RAIL_PX}px repeat(${n}, minmax(${TEAM_DAY_COLUMN_MIN_WIDTH_REM}rem, 1fr))`;
}
