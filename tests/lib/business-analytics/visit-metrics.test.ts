import { describe, expect, it } from "vitest";

import {
  ALL_PRACTITIONERS,
  beyondUsualInterval,
  clientHistories,
  completedVisitCount,
  activeClientIds,
  mostFrequentReturns,
  noNextBooking,
  pageClients,
  rankClients,
  splitReturning,
  studioInterval,
  visitsInWindow,
  visitsOf,
  visitsPerActiveClient,
  visitsWithoutClient,
  type ClientRow,
  type VisitFact,
} from "@/lib/business-analytics/visit-metrics";

// Business → Analytics. Synthetic clients only. Pure.
let n = 0;
const v = (clientId: string | null, localDate: string, over: Partial<VisitFact> = {}): VisitFact => ({
  appointmentId: `a${++n}`,
  clientId,
  localDate,
  practitionerId: "p1",
  status: "completed",
  ...over,
});
const W = { startLocal: "2026-11-01", endLocalExclusive: "2026-11-20" };

describe("what is a visit", () => {
  it("only a completed appointment is a visit; cancelled, no-show and confirmed are not", () => {
    const facts = [v("c1", "2026-11-02"), v("c1", "2026-11-03", { status: "cancelled" }), v("c1", "2026-11-04", { status: "no_show" }), v("c1", "2026-11-05", { status: "confirmed" })];
    expect(visitsOf(facts)).toHaveLength(1);
  });
  it("a repeated appointment id is one visit", () => {
    const a = v("c1", "2026-11-02");
    expect(visitsOf([a, { ...a }])).toHaveLength(1);
  });
  it("the practitioner filter: one, unattributed, all", () => {
    const facts = [v("c1", "2026-11-02", { practitionerId: "p1" }), v("c2", "2026-11-02", { practitionerId: "p2" }), v("c3", "2026-11-02", { practitionerId: null })];
    expect(visitsOf(facts, { kind: "one", practitionerId: "p2" }).map((x) => x.clientId)).toEqual(["c2"]);
    expect(visitsOf(facts, { kind: "unattributed" }).map((x) => x.clientId)).toEqual(["c3"]);
    expect(visitsOf(facts, ALL_PRACTITIONERS)).toHaveLength(3);
  });
  it("the window is half-open: the end date itself is excluded", () => {
    const facts = [v("c1", "2026-10-31"), v("c1", "2026-11-01"), v("c1", "2026-11-19"), v("c1", "2026-11-20")];
    expect(visitsInWindow(facts, W).map((x) => x.localDate)).toEqual(["2026-11-01", "2026-11-19"]);
    expect(completedVisitCount(facts, W)).toBe(2);
  });
});

describe("active clients, with a no-client fail-safe", () => {
  it("counts distinct clients; an appointment with no client is a visit but never an active client", () => {
    const facts = [v("c1", "2026-11-02"), v("c1", "2026-11-03"), v("c2", "2026-11-04"), v(null, "2026-11-05")];
    expect(activeClientIds(facts, W)).toEqual(["c1", "c2"]);
    expect(completedVisitCount(facts, W)).toBe(4);
    expect(visitsWithoutClient(facts, W)).toBe(1);
  });
  it("visits per active client is a number, or not available when nobody was seen (never 0 or NaN)", () => {
    expect(visitsPerActiveClient([v("c1", "2026-11-02"), v("c1", "2026-11-03"), v("c2", "2026-11-04")], W)).toEqual({ known: true, value: 1.5 });
    const none = visitsPerActiveClient([], W);
    expect(none.known).toBe(false);
  });
});

describe("returning versus first-time", () => {
  it("returning = a completed visit before the window began; the history is the whole history", () => {
    const facts = [v("c1", "2026-09-01"), v("c1", "2026-11-02"), v("c2", "2026-11-03"), v("c3", "2026-10-31"), v("c3", "2026-11-19")];
    const s = splitReturning(facts, W);
    expect(s).toMatchObject({ activeClients: 3, returning: 2, firstTime: 1 });
    expect(s.returningPercent).toEqual({ known: true, value: (100 * 2) / 3 });
  });
  it("a visit on the window's first day is not 'before'", () => {
    expect(splitReturning([v("c1", "2026-11-01")], W)).toMatchObject({ returning: 0, firstTime: 1 });
  });
  it("nobody seen: the percentage is not available, never 0", () => {
    expect(splitReturning([v("c1", "2026-09-01")], W).returningPercent.known).toBe(false);
  });
});

describe("visit interval", () => {
  it("is the mean of day gaps between distinct visit dates; two visits on one date are one date", () => {
    const h = clientHistories([v("c1", "2026-01-01"), v("c1", "2026-01-11"), v("c1", "2026-01-11"), v("c1", "2026-02-10")], "2026-11-19").get("c1")!;
    expect(h.visitDates).toEqual(["2026-01-01", "2026-01-11", "2026-02-10"]);
    expect(h.gaps).toEqual([10, 30]);
    expect(h.averageGapDays).toEqual({ known: true, value: 20 });
  });
  it("a client with fewer than two visit dates has no interval (not 0)", () => {
    const m = clientHistories([v("c1", "2026-01-01"), v("c1", "2026-01-01")], "2026-11-19");
    expect(m.get("c1")!.averageGapDays.known).toBe(false);
  });
  it("visits after the cut-off do not shape the figure", () => {
    const h = clientHistories([v("c1", "2026-01-01"), v("c1", "2026-01-08"), v("c1", "2026-12-25")], "2026-11-19").get("c1")!;
    expect(h.gaps).toEqual([7]);
  });
  it("studio figure pools the gaps; clients without a gap are excluded and counted", () => {
    const m = clientHistories(
      [v("c1", "2026-01-01"), v("c1", "2026-01-11"), v("c2", "2026-01-01"), v("c2", "2026-01-04"), v("c2", "2026-01-07"), v("c3", "2026-01-01")],
      "2026-11-19",
    );
    const s = studioInterval(m);
    // gaps: 10 | 3, 3 -> pooled (10+3+3)/3
    expect(s.pooledAverageDays).toEqual({ known: true, value: 16 / 3 });
    expect(s).toMatchObject({ clientsWithInterval: 2, clientsWithoutInterval: 1 });
    expect(studioInterval(clientHistories([v("c9", "2026-01-01")], "2026-11-19")).pooledAverageDays.known).toBe(false);
  });
  it("a no-client visit is in no history", () => {
    expect(clientHistories([v(null, "2026-01-01"), v(null, "2026-01-08")], "2026-11-19").size).toBe(0);
  });
});

describe("no next booking and beyond usual interval", () => {
  const facts = [
    v("c1", "2026-10-01"), // seen in the last 12 months, no future booking
    v("c2", "2026-10-01"), // future booking
    v("c3", "2025-11-18"), // before the 12-month look-back (today 2026-11-19 -> 2025-11-19)
    v("c4", "2025-11-19"), // exactly at the look-back start: included
  ];
  it("lists clients seen in the look-back with no future booking, as of today", () => {
    expect(noNextBooking({ visits: facts, clientsWithFutureBooking: new Set(["c2"]), todayLocal: "2026-11-19" })).toEqual(["c1", "c4"]);
  });
  it("the look-back is a parameter", () => {
    expect(noNextBooking({ visits: facts, clientsWithFutureBooking: new Set(), todayLocal: "2026-11-19", lookbackMonths: 2 })).toEqual(["c1", "c2"]); // from 2026-09-19: the 2025 visits fall outside
  });
  it("beyond usual = days since last visit greater than 1.5 x the client's own average gap; fewer than two dates is 'not enough history'", () => {
    const hist = clientHistories(
      [
        v("late", "2026-08-01"), v("late", "2026-08-15"), // gap 14, last 2026-08-15, 96 days ago: 96 > 21
        v("fine", "2026-11-01"), v("fine", "2026-11-15"), // gap 14, last 4 days ago
        v("edge", "2026-10-01"), v("edge", "2026-10-15"), // gap 14, last 35 days ago: 35 > 21
        v("exact", "2026-10-15"), v("exact", "2026-10-29"), // gap 14, last 21 days ago: 21 is NOT > 21
        v("booked", "2026-01-01"), v("booked", "2026-01-15"), // old, but has a future booking
        v("single", "2026-01-01"), // one date: not enough history
      ],
      "2026-11-19",
    );
    const r = beyondUsualInterval({ histories: hist, clientsWithFutureBooking: new Set(["booked"]), todayLocal: "2026-11-19" });
    expect(r.clientIds).toEqual(["edge", "late"]);
    expect(r.notEnoughHistory).toEqual(["single"]);
  });
});

describe("rankings are total and stable", () => {
  const row = (clientId: string, name: string, over: Partial<ClientRow> = {}): ClientRow => ({ clientId, name, periodVisits: 1, periodPaidCents: 0, lifetimePaidCents: 0, averageGapDays: null, lastVisitDate: null, ...over });
  const rows = [
    row("3", "Casey", { periodPaidCents: 500, periodVisits: 2 }),
    row("1", "Avery", { periodPaidCents: 500, periodVisits: 2 }),
    row("2", "Blair", { periodPaidCents: 900, periodVisits: 1 }),
    row("4", "Drew", { periodPaidCents: null, periodVisits: 9 }),
  ];
  it("spend: larger first, ties by visits then name then id, an unknown amount last", () => {
    expect(rankClients(rows, "spend", 10).map((r) => r.name)).toEqual(["Blair", "Avery", "Casey", "Drew"]);
  });
  it("is the same whatever order the rows arrive in", () => {
    expect(rankClients([...rows].reverse(), "spend", 10).map((r) => r.name)).toEqual(rankClients(rows, "spend", 10).map((r) => r.name));
  });
  it("top-N is clamped to 1..100 and never returns more", () => {
    expect(rankClients(rows, "name", 2).map((r) => r.name)).toEqual(["Avery", "Blair"]);
    expect(rankClients(rows, "name", 0)).toHaveLength(1);
    expect(rankClients(rows, "name", Number.NaN)).toHaveLength(1);
    const many = Array.from({ length: 150 }, (_, i) => row(String(i), `N${String(i).padStart(3, "0")}`));
    expect(rankClients(many, "name", 1000)).toHaveLength(100);
  });
  it("most frequent returns: only clients with an interval, shortest first", () => {
    const withGaps = [row("1", "A", { averageGapDays: 30 }), row("2", "B", { averageGapDays: 7 }), row("3", "C", { averageGapDays: null })];
    expect(mostFrequentReturns(withGaps, 5).map((r) => r.name)).toEqual(["B", "A"]);
  });
  it("last visit: most recent first, none last", () => {
    const r = [row("1", "A", { lastVisitDate: "2026-01-01" }), row("2", "B", { lastVisitDate: "2026-06-01" }), row("3", "C", { lastVisitDate: null })];
    expect(rankClients(r, "last_visit", 3).map((x) => x.name)).toEqual(["B", "A", "C"]);
  });
  it("pages are at most 100 rows; a page past the end is empty, not an error", () => {
    const many = Array.from({ length: 230 }, (_, i) => row(String(i), `N${String(i).padStart(3, "0")}`));
    const p1 = pageClients(many, "name", 1, 1000);
    expect(p1.rows).toHaveLength(100);
    expect(p1.pageSize).toBe(100);
    expect(p1.pageCount).toBe(3);
    expect(pageClients(many, "name", 3, 100).rows).toHaveLength(30);
    expect(pageClients(many, "name", 9, 100).rows).toEqual([]);
    expect(pageClients(many, "name", -4, 25).page).toBe(1);
  });
});
