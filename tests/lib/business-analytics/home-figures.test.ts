import { describe, expect, it } from "vitest";

import { buildHomeFigures, cumulativePath, heroMoney, NOT_AVAILABLE } from "@/lib/business-analytics/home-figures";
import type { OverviewView } from "@/lib/business-analytics/overview-model";

// Business → Overview: the figure mapping. The distinction under test is the whole point: a genuine ZERO prints as a number, a figure that cannot be computed
// is "unavailable" and never a number. Only the fields the mapping reads are built here.
const ok = <T,>(value: T) => ({ available: true as const, value });
const no = (reason: string) => ({ available: false as const, reason });
const base = {
  currentLabel: "Month to date: 1–24 Nov 2026 (24 days)",
  comparisonLabel: "1–24 Oct 2026 (24 days)",
  currentRange: { startLocal: "2026-11-01", lastLocal: "2026-11-24" },
  currency: "cad",
};
const blank = {
  collected: no("read_failed"),
  completedVisits: no("read_failed"),
  activeClients: no("read_failed"),
  averagePaid: no("read_failed"),
  series: no("read_failed"),
  previousSeries: no("read_failed"),
};
const view = (over: Record<string, unknown>) => ({ ...base, ...blank, ...over }) as unknown as OverviewView;
const point = (key: string, collectedCents: number) => ({ key, collectedCents, completedVisits: 0 });

describe("heroMoney", () => {
  it("whole dollars when there are no cents, every cent otherwise", () => {
    expect(heroMoney(607500)).toBe("$6,075");
    expect(heroMoney(607550)).toBe("$6,075.50");
    expect(heroMoney(0)).toBe("$0");
    expect(heroMoney(5)).toBe("$0.05");
  });
});

describe("a studio with an active month", () => {
  const f = buildHomeFigures(
    view({
      collected: ok({ headlineCents: 607500, change: { kind: "percent", percent: 53.43 }, previousCents: 396000 }),
      completedVisits: ok({ count: 41 }),
      activeClients: ok({ count: 30 }),
      averagePaid: ok({ averageCents: { known: true, value: 14800 } }),
      series: ok({ unit: "day", points: [point("2026-11-01", 10000), point("2026-11-02", 0), point("2026-11-03", 5000)] }),
      previousSeries: ok({ unit: "day", points: [point("2026-10-01", 2000), point("2026-10-02", 2000)] }),
    }),
  );
  it("prints the hero with its comparison", () => {
    expect(f.collected).toMatchObject({ state: "value", value: { display: "$6,075", cents: 607500, comparison: { kind: "percent", text: "+53.4%", direction: "up" } } });
  });
  it("prints the smaller figures", () => {
    expect(f.completedVisits).toEqual({ state: "value", value: 41 });
    expect(f.activeClients).toEqual({ state: "value", value: 30 });
    expect(f.averagePaid).toEqual({ state: "value", value: "$148" });
  });
  it("draws both lines cumulatively; a day with nothing collected keeps the line level, never a drop", () => {
    expect(f.trend).toMatchObject({ state: "value", value: { current: [10000, 10000, 15000], previous: [2000, 4000], unit: "day" } });
  });
});

describe("a studio with NO activity: a genuine $0 and an unavailable figure display differently", () => {
  const f = buildHomeFigures(
    view({
      collected: ok({ headlineCents: 0, change: { kind: "none_recorded" }, previousCents: 0 }),
      completedVisits: ok({ count: 0 }),
      activeClients: ok({ count: 0 }),
      averagePaid: ok({ averageCents: { known: false, reason: "No completed visit has a known payment." } }),
      series: ok({ unit: "day", points: [point("2026-11-01", 0), point("2026-11-02", 0)] }),
      previousSeries: ok({ unit: "day", points: [point("2026-10-01", 0)] }),
    }),
  );
  it("collected is a real $0, with no invented percentage", () => {
    expect(f.collected).toMatchObject({ state: "value", value: { display: "$0", cents: 0, comparison: { kind: "none_recorded" } } });
    expect(f.completedVisits).toEqual({ state: "value", value: 0 });
    expect(f.activeClients).toEqual({ state: "value", value: 0 });
  });
  it("the average of nothing is UNAVAILABLE, not $0", () => {
    expect(f.averagePaid).toEqual({ state: "unavailable", reason: "No completed visit has a known payment." });
  });
  it("the line is flat, and flat at the bottom", () => {
    expect(f.trend).toMatchObject({ state: "value", value: { current: [0, 0] } });
    expect(cumulativePath([0, 0], 0, 2, 312, 100)).toBe("M3.0 90.0 L309.0 90.0");
  });
});

describe("unavailable figures are never zero", () => {
  const f = buildHomeFigures(
    view({
      collected: no("read_failed"),
      completedVisits: no("too_many_appointments"),
      activeClients: no("read_failed"),
      averagePaid: no("read_failed"),
      series: no("read_failed"),
      previousSeries: no("read_failed"),
    }),
  );
  it("each is state unavailable with a plain reason, and carries no number", () => {
    for (const fig of [f.collected, f.completedVisits, f.activeClients, f.averagePaid, f.trend]) {
      expect(fig.state).toBe("unavailable");
      expect(JSON.stringify(fig)).not.toMatch(/"value"/);
    }
    expect(f.completedVisits).toMatchObject({ reason: "Too many appointments to summarise this at once." });
  });
  it("a comparison that cannot be read leaves the hero standing with 'Comparison not available'", () => {
    const g = buildHomeFigures(view({ collected: ok({ headlineCents: 12300, change: { kind: "unavailable" }, previousCents: null }), series: ok({ unit: "day", points: [] }), previousSeries: no("read_failed") }));
    expect(g.collected).toMatchObject({ state: "value", value: { display: "$123", comparison: { kind: "unavailable", text: "Comparison not available" } } });
    expect(g.trend).toMatchObject({ state: "value", value: { previous: null } });
  });
  it("the shared words say Not available", () => {
    expect(NOT_AVAILABLE).toBe("Not available");
  });
});

describe("percent wording", () => {
  const pct = (percent: number) => (buildHomeFigures(view({ collected: ok({ headlineCents: 1, change: { kind: "percent", percent }, previousCents: 1 }) })).collected as { value: { comparison: { text: string; direction: string } } }).value.comparison;
  it("up, down, and a change that rounds to nothing", () => {
    expect(pct(53.44)).toEqual({ kind: "percent", text: "+53.4%", direction: "up" });
    expect(pct(-12.26)).toEqual({ kind: "percent", text: "−12.3%", direction: "down" });
    expect(pct(0.01)).toEqual({ kind: "percent", text: "0.0%", direction: "flat" });
  });
});
