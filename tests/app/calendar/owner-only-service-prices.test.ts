import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatServiceLabel } from "@/lib/booking/format";

// Published service prices follow the "See published service prices and booking fees" control (Sam, 7 Nov
// 2026; default ON, owners always). With it OFF a non-owner's Calendar payload carries no service price and the
// quick-book picker label ("Name . $NN") prints none. The sentinel is a distinctive amount ($987.65 would
// print as "$988"), so the absence check cannot pass by coincidence.
const SENTINEL_CENTS = 98765;
const SENTINEL_LABEL = "$988";

const selects: string[] = [];
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from() {
      const self: Record<string, unknown> = new Proxy(
        {},
        {
          get(_t, prop: string) {
            if (prop === "then") {
              return (res: (v: unknown) => void) =>
                res({
                  data: [
                    {
                      id: "svc1",
                      studio_id: "s1",
                      name: "Facial",
                      modality: "other",
                      default_duration_minutes: 60,
                      active: true,
                      sort_order: 0,
                      price_cents: SENTINEL_CENTS,
                    },
                  ],
                  error: null,
                });
            }
            if (prop === "select") return (arg: string) => { selects.push(arg); return self; };
            return () => self;
          },
        },
      );
      return self;
    },
  }),
}));

const PAGE = readFileSync("app/(app)/calendar/page.tsx", "utf8");

beforeEach(() => {
  selects.length = 0;
});

describe("Calendar: no service price reaches a non-owner (week view, day view, quick-book picker)", () => {
  it("every getActiveServices call on the Calendar page takes its options from the control; none is bare", () => {
    const calls = [...PAGE.matchAll(/getActiveServices\(([^)]*)\)/g)].map((m) => m[1].trim());
    expect(calls).toEqual(["studio.id, reads", "studio.id, reads"]);
    expect([...PAGE.matchAll(/publishedServicePriceReads\(studio\.id, isOwner\)/g)]).toHaveLength(2);
  });

  it("a non-owner read selects no price column, returns price_cents null, and the picker label prints no amount", async () => {
    const { getActiveServices } = await import("@/lib/booking/queries");
    const rows = await getActiveServices("s1", { includePrices: false });
    expect(selects[0]).not.toMatch(/price|\*/);
    expect(rows.every((r) => r.price_cents === null)).toBe(true);
    const payload = JSON.stringify(rows);
    expect(payload).not.toContain(String(SENTINEL_CENTS));
    expect(payload).not.toMatch(/"price_cents":\d/);
    for (const r of rows) {
      const label = formatServiceLabel(r);
      expect(label).not.toContain("$");
      expect(label).not.toContain("988");
    }
  });

  it("positive control: an owner read keeps the price and the picker label prints it", async () => {
    const { getActiveServices } = await import("@/lib/booking/queries");
    const rows = await getActiveServices("s1", { includePrices: true });
    expect(selects[0]).toBe("*");
    expect(rows[0].price_cents).toBe(SENTINEL_CENTS);
    expect(formatServiceLabel(rows[0])).toContain(SENTINEL_LABEL);
  });
});
