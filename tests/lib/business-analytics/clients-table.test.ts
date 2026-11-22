import { describe, expect, it } from "vitest";

import { rankClientsTable, type ClientTableFigure } from "@/lib/business-analytics/clients-table";

const fig = (id: string, over: Partial<ClientTableFigure> = {}): ClientTableFigure => ({ clientId: id, periodVisits: 1, periodPaidCents: 1000, lifetimePaidCents: 5000, averageGapDays: null, lastVisitDate: "2026-11-01", firstVisitDate: "2026-01-01", hasNextBooking: false, beyondUsual: false, ...over });
const names = (o: Record<string, string>) => ({ ok: true as const, names: new Map(Object.entries(o)) });
const run = (figures: ClientTableFigure[], over: Partial<Parameters<typeof rankClientsTable>[0]> = {}) =>
  rankClientsTable({ figures, lookup: names({ a: "Ana", b: "Ben", c: "Cy" }), sort: "spend", chip: "all", page: 1, lifetimeFailure: null, ...over });
const val = (r: ReturnType<typeof run>) => (r.available ? r.value : null);

describe("rankClientsTable", () => {
  it("a client with no completed visit in the period is neither a row nor counted as seen", () => {
    const t = val(run([fig("a"), fig("b", { periodVisits: 0 })]));
    expect(t?.rows.map((r) => r.name)).toEqual(["Ana"]);
    expect(t?.seen).toBe(1);
    expect(t?.notListed).toBe(0);
  });
  it("with a lifetime failure no row carries a lifetime figure, even one that was passed in", () => {
    const t = val(run([fig("a")], { lifetimeFailure: "too_many_appointments" }));
    expect(t?.rows[0].lifetimePaidCents).toBeNull();
    expect(t?.lifetime).toEqual({ available: false, reason: "too_many_appointments" });
  });
  it("with a failed history read, first visit, average gap and beyond usual are unknown, even if figures were passed in", () => {
    const t = val(run([fig("a", { averageGapDays: 30, beyondUsual: true })], { historyFailure: "too_many_appointments" }));
    expect(t?.rows[0].firstVisitDate).toBeNull();
    expect(t?.rows[0].averageGapDays).toBeNull();
    expect(t?.rows[0].beyondUsual).toBeNull();
    expect(t?.rows[0].lastVisitDate).toBe("2026-11-01");
    expect(t?.chipCounts.beyondUsual).toBeNull();
    expect(t?.history).toEqual({ available: false, reason: "too_many_appointments" });
  });
  it("with a failed history read the beyond-usual chip is refused, never an unfiltered or period-only table", () => {
    expect(run([fig("a", { beyondUsual: true })], { chip: "beyond_usual", historyFailure: "read_failed" })).toEqual({ available: false, reason: "read_failed" });
  });
  it("with a good history read the history columns are shown and the table says so", () => {
    const t = val(run([fig("a", { averageGapDays: 30 })]));
    expect(t?.rows[0].firstVisitDate).toBe("2026-01-01");
    expect(t?.rows[0].averageGapDays).toBe(30);
    expect(t?.history).toEqual({ available: true });
  });
  it("under a failed history read the average-gap sort ignores the raw gaps, so the order is not by a period-only figure", () => {
    const figs = [fig("a", { averageGapDays: 50 }), fig("b", { averageGapDays: 10 }), fig("c", { averageGapDays: 30 })];
    expect(val(run(figs, { sort: "interval", historyFailure: "read_failed" }))?.rows.map((r) => r.name)).toEqual(["Ben", "Ana", "Cy"].sort()); // all unknown, so visits then name
    expect(val(run(figs, { sort: "interval" }))?.rows.map((r) => r.name)).toEqual(["Ben", "Cy", "Ana"]); // known gaps, shortest first
  });
  it("under a failed history read the last-visit sort still orders by the most recent visit, which needs no history", () => {
    const figs = [fig("a", { lastVisitDate: "2026-11-01" }), fig("b", { lastVisitDate: "2026-11-20" }), fig("c", { lastVisitDate: "2026-11-10" })];
    expect(val(run(figs, { sort: "last_visit", historyFailure: "read_failed" }))?.rows.map((r) => r.name)).toEqual(["Ben", "Cy", "Ana"]);
  });
  it("with the period money unreadable no paid figure, total or unconfirmed count is known, and none is the count of every client", () => {
    const t = val(run([fig("a", { periodPaidCents: null }), fig("b", { periodPaidCents: 500 })], { periodMoneyFailure: "currency_unknown" }));
    expect(t?.rows.map((r) => r.periodPaidCents)).toEqual([null, null]);
    expect(t?.rows.map((r) => r.name)).toEqual(["Ana", "Ben"]); // the spend sort cannot use a paid figure that is unknown, so it falls to visits then name
    expect(t?.paidAcrossSeenCents).toBeNull();
    expect(t?.seenWithoutConfirmedPayment).toBeNull();
    expect(t?.periodMoney).toEqual({ available: false, reason: "currency_unknown" });
  });
  it("with the period money readable the unconfirmed count is exact and the money is available", () => {
    const t = val(run([fig("a", { periodPaidCents: null }), fig("b", { periodPaidCents: 500 })]));
    expect(t?.seenWithoutConfirmedPayment).toBe(1);
    expect(t?.paidAcrossSeenCents).toBe(500);
    expect(t?.periodMoney).toEqual({ available: true });
  });
  it("a null paid amount ranks last and is never counted as zero in the total", () => {
    const t = val(run([fig("a", { periodPaidCents: null }), fig("b", { periodPaidCents: 100 })]));
    expect(t?.rows.map((r) => r.name)).toEqual(["Ben", "Ana"]);
    expect(t?.paidAcrossSeenCents).toBe(100);
    expect(t?.seenWithoutConfirmedPayment).toBe(1);
  });
  it("row keys are rank positions across pages and carry no client id", () => {
    const many = Array.from({ length: 30 }, (_, i) => fig(`c${i}`, { periodPaidCents: 100 + i }));
    const lookup = names(Object.fromEntries(many.map((f, i) => [f.clientId, `Name ${String(i).padStart(2, "0")}`])));
    const p2 = val(run(many, { lookup, page: 2 }));
    expect(p2?.rows.map((r) => r.rowKey)).toEqual(["row-26", "row-27", "row-28", "row-29", "row-30"]);
    expect([p2?.rowsFrom, p2?.rowsTo, p2?.pageCount, p2?.shown]).toEqual([26, 30, 2, 30]);
    expect(JSON.stringify(p2)).not.toMatch(/"c\d+"/);
  });
  it("an unavailable chip is refused, never shown as the unfiltered table", () => {
    const r = run([fig("a", { hasNextBooking: null })], { chip: "no_next_booking" });
    expect(r).toEqual({ available: false, reason: "read_failed" });
  });
  it("a name lookup that failed makes the whole table unavailable", () => {
    expect(rankClientsTable({ figures: [fig("a")], lookup: { ok: false }, sort: "spend", chip: "all", page: 1, lifetimeFailure: null })).toEqual({ available: false, reason: "read_failed" });
  });
});
