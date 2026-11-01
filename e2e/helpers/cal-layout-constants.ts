// The day view's layout constants, read from the build under test: lib/calendar/team-day-layout.ts (HON-48). The columns are
// `minmax(TEAM_DAY_COLUMN_MIN_WIDTH_REM, 1fr)`: they fill the box, one column included, and never get narrower than the minimum.
export type CalLayoutConstants = { minColumnPx: number; railPx: number; source: string };

import { readFileSync } from "node:fs";
import path from "node:path";

// CAL_CONSTANTS_SOURCE overrides the file (default: this checkout's own lib/calendar/team-day-layout.ts).
export async function loadCalLayoutConstants(): Promise<CalLayoutConstants> {
  const src = process.env.CAL_CONSTANTS_SOURCE ?? path.resolve(process.cwd(), "lib/calendar/team-day-layout.ts");
  const text = readFileSync(src, "utf8");
  const num = (name: string): number => {
    const m = new RegExp(`export const ${name}\\s*=\\s*([0-9.]+)\\s*;`).exec(text);
    if (!m) throw new Error(`${src} does not declare the named constant ${name}`);
    return Number(m[1]);
  };
  const rail = num("TEAM_DAY_RAIL_PX");
  const rem = num("TEAM_DAY_COLUMN_MIN_WIDTH_REM");
  return { minColumnPx: rem * 16, railPx: rail, source: `${src} (TEAM_DAY_RAIL_PX=${rail}, TEAM_DAY_COLUMN_MIN_WIDTH_REM=${rem})` };
}
