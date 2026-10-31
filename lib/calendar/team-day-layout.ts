// HON-48: the team day view's column geometry, in one place so the page and
// its tests share one rule.
//
// Every practitioner column is the SAME fixed width, whatever the count. The
// old `minmax(9rem, 1fr)` track let a lone column stretch across the whole
// screen and made every column's width depend on how many were showing. With a
// fixed track the grid is as wide as its columns: one practitioner is a normal
// compact column, more practitioners make the calendar grow, and more columns
// than the screen holds scroll sideways inside the scroll box instead of being
// squeezed unreadable.

export const TEAM_DAY_RAIL_PX = 60;
export const TEAM_DAY_COLUMN_WIDTH_REM = 13;

export function teamDayGridTemplate(columnCount: number): string {
  const n = Number.isFinite(columnCount) ? Math.max(1, Math.floor(columnCount)) : 1;
  return `${TEAM_DAY_RAIL_PX}px repeat(${n}, ${TEAM_DAY_COLUMN_WIDTH_REM}rem)`;
}
