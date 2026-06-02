// Plain, server-safe calendar grid constants.
//
// IMPORTANT: these live here and NOT in DayColumn.tsx. DayColumn.tsx is a
// "use client" module, so a Server Component (calendar/page.tsx) that
// imports a value from it receives a client-reference proxy, not the
// actual number. That broke the time rail: page.tsx built its label loop
// with `Array.from({ length: HOUR_END - HOUR_START })`, and with
// HOUR_END/HOUR_START as client-reference proxies the arithmetic yielded
// a non-numeric length → 0 children → a rail that rendered but was empty.
// (Same class of bug as the formatDayHeader/formatHourLabel boundary
// issue fixed earlier.) Keeping the constants in a plain module lets both
// the server page and the client DayColumn import real numbers.

// Visible calendar day range. Widened to 6:00am to 11:00pm to cover
// early morning and late evening electrolysis schedules per pilot
// feedback. NowLine.tsx already hides itself when the current time
// is outside the visible window, so the wider range does not break
// the now-indicator behaviour. The slot grid keeps 30-minute rows at
// 30 px each (1 px per minute) so any code positioning blocks by
// minute offset continues to work without changes.
export const HOUR_START = 6;
export const HOUR_END = 23;
export const ROW_HEIGHT_PX = 30; // 30 minutes per row, 1 px per minute
export const ROW_MINUTES = 30;
export const VISIBLE_MINUTES = (HOUR_END - HOUR_START) * 60;
export const GRID_HEIGHT = (VISIBLE_MINUTES / ROW_MINUTES) * ROW_HEIGHT_PX;
