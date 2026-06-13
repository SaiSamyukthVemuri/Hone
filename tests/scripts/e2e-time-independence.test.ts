import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// Imported from the dependency-free module: seed.ts pulls in
// local-env.ts, whose local-only guard throws by design in the fast
// CI lane (hosted env vars).
import { timezoneWithLocalMorning } from "../../e2e/helpers/timezone";

// Post-PR #238 fix: the browser E2E lane must pass at any real-world
// hour. The specs book through the REAL public flow and assert the
// appointment on the Dashboard "Today" roster, so the seeded studio's
// LOCAL day must still have bookable slots when the run starts. The
// fixture now picks a fixed-offset timezone where the studio clock
// reads ~09:00 at seed time.

const SEED = readFileSync(join(process.cwd(), "e2e/helpers/seed.ts"), "utf8");

function localHour(zone: string, date: Date): number {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hour: "numeric",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((p) => p.type === "hour");
  return Number(part?.value);
}

describe("timezoneWithLocalMorning", () => {
  it("yields 09:xx studio-local time at every UTC hour of the day", () => {
    for (let h = 0; h < 24; h++) {
      const now = new Date(Date.UTC(2026, 5, 13, h, 30, 0));
      const zone = timezoneWithLocalMorning(now);
      expect(zone, `utc hour ${h}`).toMatch(/^Etc\/GMT[+-]\d{1,2}$/);
      expect(localHour(zone, now), `utc hour ${h} in ${zone}`).toBe(9);
    }
  });

  it("stays within the valid IANA Etc/GMT offset range", () => {
    for (let h = 0; h < 24; h++) {
      const zone = timezoneWithLocalMorning(new Date(Date.UTC(2026, 5, 13, h)));
      const offset = Number(zone.replace("Etc/GMT", ""));
      // IANA ships Etc/GMT+12 .. Etc/GMT-14; we stay well inside.
      expect(offset).toBeGreaterThanOrEqual(-12);
      expect(offset).toBeLessThanOrEqual(11);
    }
  });
});

describe("seed fixture", () => {
  it("the studio insert uses the morning zone, not a hardcoded timezone", () => {
    expect(SEED).toMatch(/timezoneWithLocalMorning\(\)/);
    expect(SEED).not.toMatch(/'America\/Toronto'/);
  });

  it("availability stays the wide every-day window the slot math assumes", () => {
    expect(SEED).toMatch(/'06:00', '22:00' from generate_series\(0, 6\)/);
  });
});
