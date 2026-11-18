import { beforeEach, describe, expect, it, vi } from "vitest";

// The loop this guards against: the page fingerprints the rows ITS loaders returned, the probe fingerprints the rows ITS
// reads return. If their filters differ, the probe sees "changed" for data the screen can never show, and the screen
// refreshes forever. So run the page's loaders and the probe's reader against a recording client and require the same
// table, studio and range predicates.

type Call = { table: string; filters: string[] };
const calls = vi.hoisted(() => [] as Array<{ table: string; filters: string[] }>);

vi.mock("@/lib/supabase/server", () => {
  function builder(table: string) {
    const rec = { table, filters: [] as string[] };
    calls.push(rec);
    const proxy: unknown = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === "then") return (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
          return (...args: unknown[]) => {
            if (["eq", "gt", "gte", "lt", "lte", "neq", "in", "is"].includes(prop)) rec.filters.push(`${prop}(${String(args[0])}, ${String(args[1])})`);
            return proxy;
          };
        },
      },
    );
    return proxy;
  }
  return { createClient: async () => ({ from: (table: string) => builder(table) }) };
});

import { getAppointmentsForRange, getBlockouts, getRecurringBreakOccurrencesForRange, getTimedBlocksForRange } from "@/lib/booking/queries";
import { readCalendarFingerprint } from "@/lib/calendar/change-probe-read";
import { calendarLoadRange, type CalendarView } from "@/lib/calendar/calendar-load-range";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const TZ = "America/Toronto";

function byTable(list: Call[]) {
  const out = new Map<string, string[][]>();
  for (const c of list) out.set(c.table, [...(out.get(c.table) ?? []), [...c.filters].sort()]);
  return out;
}

beforeEach(() => {
  calls.length = 0;
});

const CASES: Array<[CalendarView, string]> = [
  ["day", "2026-11-18"],
  ["week", "2026-11-15"],
  ["month", "2026-11-01"],
];

describe("the probe reads what the page loads, with the same filters", () => {
  for (const [view, anchor] of CASES) {
    it(`${view}: same tables, same studio and range predicates`, async () => {
      const { startUtc, endUtc } = calendarLoadRange(view, anchor, TZ);
      const s = startUtc.toISOString();
      const e = endUtc.toISOString();

      await Promise.all([
        getAppointmentsForRange(STUDIO, s, e),
        getTimedBlocksForRange(STUDIO, s, e),
        getBlockouts(STUDIO),
        getRecurringBreakOccurrencesForRange(STUDIO, s, e),
      ]);
      const page = byTable(calls);
      calls.length = 0;

      await readCalendarFingerprint({ studioId: STUDIO, timezone: TZ, view, anchor });
      const probe = byTable(calls);

      for (const table of ["appointments", "studio_timed_blocks", "studio_blockouts", "studio_recurring_break_occurrences"]) {
        expect(probe.has(table), `${table} is read by the probe`).toBe(true);
        expect(page.has(table), `${table} is read by the page`).toBe(true);
        // The page's loaders may add filters the probe lacks only if they are not row-selecting; compare as sets.
        const pageFilters = new Set((page.get(table) ?? []).flat());
        const probeFilters = new Set((probe.get(table) ?? []).flat());
        expect([...probeFilters].sort(), `${table} filters (${view})`).toEqual([...pageFilters].sort());
      }
      // the studio comes from the caller's argument on every read, and nothing else is read
      expect(new Set(probe.keys())).toEqual(new Set(["appointments", "studio_timed_blocks", "studio_blockouts", "studio_recurring_break_occurrences"]));
      for (const c of calls) expect(c.filters).toContain(`eq(studio_id, ${STUDIO})`);
    });
  }

  it("the blockouts read is NOT range-limited (the page loads every blockout of the studio)", async () => {
    await readCalendarFingerprint({ studioId: STUDIO, timezone: TZ, view: "day", anchor: "2026-11-18" });
    const blockouts = calls.find((c) => c.table === "studio_blockouts")!;
    expect(blockouts.filters).toEqual([`eq(studio_id, ${STUDIO})`]);
  });
});
