import { describe, expect, it, vi } from "vitest";

import { NOW, studio, studioClient, synthetic } from "./helpers-synthetic-studio";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// The build derives each set of rows' visit facts once and remembers them by the rows array AND the time zone. A memo that ignored the zone would hand the
// facts of the first zone to every later build over the same array. Nothing else builds twice over one array, so this test does: the same arrays under two
// zones, each compared with the build over a copy of the arrays (a different identity, so nothing is remembered).

type Input = import("@/lib/business-analytics/overview-model").OverviewInput;
const captured: Input[] = [];
vi.mock("@/lib/business-analytics/overview-model", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/business-analytics/overview-model")>();
  return { ...actual, buildOverview: (i: Input) => { captured.push(i); return actual.buildOverview(i); } };
});

const TORONTO = "America/Toronto";
const TOKYO = "Asia/Tokyo";

describe("the Overview build remembers visit facts per rows array AND per time zone", () => {
  it("the same rows under Toronto and then Tokyo give two different answers, each equal to the build over a fresh copy", async () => {
    const { loadOverview } = await import("@/lib/business-analytics/server/overview-read");
    const { buildOverview } = await import("@/lib/business-analytics/overview-model");
    captured.length = 0;
    const r = await loadOverview({ role: "owner" }, studio, "cad", {}, { strict: false }, NOW, studioClient(synthetic(1100)).client);
    expect(r).toMatchObject({ ok: true });
    const input = captured[0];
    expect(input).toBeDefined();
    expect(input.timezone).toBe(TORONTO);

    const fresh = (zone: string): Input => structuredClone({ ...input, timezone: zone }); // new arrays: nothing is remembered for them
    const sharedToronto = buildOverview({ ...input, timezone: TORONTO });
    const sharedTokyo = buildOverview({ ...input, timezone: TOKYO }); // the SAME arrays as the Toronto build above
    const freshToronto = buildOverview(fresh(TORONTO));
    const freshTokyo = buildOverview(fresh(TOKYO));

    expect(JSON.stringify(sharedToronto)).toBe(JSON.stringify(freshToronto));
    expect(JSON.stringify(sharedTokyo)).toBe(JSON.stringify(freshTokyo));
    // anti-vacuity: the two zones really change what the build says (the synthetic starts straddle local midnight in one of them), so equality above is not trivial
    expect(JSON.stringify(sharedTokyo)).not.toBe(JSON.stringify(sharedToronto));
    // and in the other order, on the same arrays again
    expect(JSON.stringify(buildOverview({ ...input, timezone: TORONTO }))).toBe(JSON.stringify(freshToronto));
  }, 60_000);
});
