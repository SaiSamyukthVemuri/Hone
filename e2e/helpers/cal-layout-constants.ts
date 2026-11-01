// The day view's layout constants. Willow exports NAMED constants from the code; this spec imports them when the module is
// present and otherwise falls back to the values the production page already hard-codes, so the same spec runs RED against
// production and GREEN against the fix. Set CAL_CONSTANTS_MODULE (a path relative to this file) once the module path is known.
export type CalLayoutConstants = { minColumnPx: number; singleColumnMaxPx: number | null; railPx: number; source: string };

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// CAL_CONSTANTS_SOURCE = path to lib/calendar/team-day-layout.ts of the build under test. The named constants are read from that file's
// `export const TEAM_DAY_RAIL_PX` / `TEAM_DAY_COLUMN_WIDTH_REM` declarations (a fixed-width design: every column is that width, so the column
// width IS both the minimum and the compact single-column width; 1px of slack for sub-pixel layout).
export async function loadCalLayoutConstants(): Promise<CalLayoutConstants> {
  // default: this checkout's own lib/calendar/team-day-layout.ts (absent on production before HON-48, so the spec falls back to its literals)
  const own = path.resolve(process.cwd(), "lib/calendar/team-day-layout.ts");
  const src = process.env.CAL_CONSTANTS_SOURCE ?? (existsSync(own) ? own : undefined);
  if (src) {
    const text = readFileSync(src, "utf8");
    const num = (name: string): number => {
      const m = new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)\\s*;`).exec(text);
      if (!m) throw new Error(`${src} does not declare the named constant ${name}`);
      return Number(m[1]);
    };
    const rail = num("TEAM_DAY_RAIL_PX");
    const columnPx = num("TEAM_DAY_COLUMN_WIDTH_REM") * 16;
    return { minColumnPx: columnPx - 1, singleColumnMaxPx: columnPx + 1, railPx: rail, source: `${src} (TEAM_DAY_RAIL_PX=${rail}, TEAM_DAY_COLUMN_WIDTH_REM=${columnPx / 16})` };
  }
  // production today: gridTemplateColumns `60px repeat(n, minmax(9rem, 1fr))`, 9rem = 144px; no compact constant exists.
  return { minColumnPx: 144, singleColumnMaxPx: null, railPx: 60, source: "production literals (9rem minimum, no named constant)" };
}
