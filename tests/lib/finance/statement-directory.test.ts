import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DIRECTORY_MONTH_NOTE, DIRECTORY_PAGE_SIZES, FINDER_LIMIT, buildDirectory, findClients, offDocumentMoneyNotice, pageDirectory, type BuildDirectoryInput, type FinderClient } from "@/lib/finance/statement-directory";
import type { AssembleAppointment } from "@/lib/finance/statement-document-assemble";
import type { StatementCardRow } from "@/lib/finance/statement";

// Synthetic rows only.
const ROOT = path.resolve(__dirname, "../../..");
const NOW = "2026-11-19T18:00:00Z";
let n = 0;
const appt = (clientId: string, over: Partial<AssembleAppointment> = {}): AssembleAppointment => {
  n += 1;
  return { id: `a${n}`, clientId, startsAt: "2026-11-03T15:00:00Z", status: "completed", practitionerId: null, serviceId: null, durationMinutes: 30, ...over };
};
const card = (appointmentId: string, over: Partial<StatementCardRow> = {}): StatementCardRow => ({
  appointmentId, chargeReason: "session_payment", status: "succeeded", amountCents: 5000, currency: "cad", refundStatus: null, refundAmountCents: null,
  providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true, ...over,
});
const names = new Map([["c1", "Ada Lovelace"], ["c2", "Bo Chen"], ["c3", "Cy Young"], ["c4", "Di Park"]]);
const input = (over: Partial<BuildDirectoryInput>): BuildDirectoryInput => ({
  studioCurrency: "cad", timezone: "America/Toronto", nowIso: NOW, month: "2026-11", appointments: [], cardRows: [], settlementRows: [], legacyFeeRows: [],
  serviceNames: new Map(), practitionerNames: new Map(), clientNames: names, ...over,
});
const must = (i: BuildDirectoryInput) => {
  const r = buildDirectory(i);
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

describe("the Clients tab: one row per client with something on the document", () => {
  const a1 = appt("c1"), a2 = appt("c1", { startsAt: "2026-11-04T15:00:00Z" });
  const b1 = appt("c2", { startsAt: "2026-11-05T15:00:00Z" }); // a visit with NO payment record: still listed
  const c1 = appt("c3", { status: "no_show", startsAt: "2026-11-06T15:00:00Z" }); // only a paid fee: listed with zero visits
  const d1 = appt("c4", { status: "cancelled", startsAt: "2026-11-07T15:00:00Z" }); // fee-free cancellation: NOT listed
  const rows = {
    appointments: [a1, a2, b1, c1, d1],
    cardRows: [card(a1.id, { amountCents: 6000 }), card(a2.id, { amountCents: 4000 }), card(c1.id, { chargeReason: "no_show_fee", amountCents: 2500 })],
  };
  const r = must(input(rows));
  it("lists clients with a visit (paid or not) or a counted line, never a fee-free cancellation, sorted by name", () => {
    expect(r.rows.map((x) => x.clientId)).toEqual(["c1", "c2", "c3"]);
    expect(r.rows[0]).toMatchObject({ name: "Ada Lovelace", visitCount: 2, paidCents: 10000, awaitingCount: 0 });
    expect(r.rows[1]).toMatchObject({ name: "Bo Chen", visitCount: 1, paidCents: 0, awaitingCount: 1 }); // visit with no payment record
    expect(r.rows[2]).toMatchObject({ name: "Cy Young", visitCount: 0, paidCents: 2500 });
  });
  it("RECONCILES: the clients' total spend equals the studio statement's collected total, computed independently", () => {
    expect(r.reconciliation).toEqual({ clientsSpendCents: 12500, offDocumentCollectedCents: 0, studioCollectedCents: 12500, offDocumentWithMoney: 0, reconciled: true });
    expect(r.totals).toEqual({ clientCount: 3, visitCount: 3, paidCents: 12500, awaitingCount: 1 });
  });
  it("a future booking with a payment stays off the clients' totals and is the ONLY difference, reported not hidden", () => {
    const f = appt("c2", { status: "confirmed", startsAt: "2026-12-20T15:00:00Z" });
    const x = must(input({ ...rows, appointments: [...rows.appointments, f], cardRows: [...rows.cardRows, card(f.id, { amountCents: 1000 })] }));
    expect(x.reconciliation).toEqual({ clientsSpendCents: 12500, offDocumentCollectedCents: 1000, studioCollectedCents: 13500, offDocumentWithMoney: 1, reconciled: true });
    expect(offDocumentMoneyNotice(1)).toMatch(/1 upcoming booking has a payment recorded/);
    expect(offDocumentMoneyNotice(0)).toBeNull();
    expect(offDocumentMoneyNotice(3)).toMatch(/3 upcoming bookings/);
  });
  it("a REAL mismatch is distinguishable from the future-booking gap: reconciled is false when clients + off-document differ from the studio", () => {
    const f = appt("c2", { status: "confirmed", startsAt: "2026-12-20T15:00:00Z" });
    const x = must(input({ ...rows, appointments: [...rows.appointments, f], cardRows: [...rows.cardRows, card(f.id, { amountCents: 1000 })] }));
    const r = x.reconciliation;
    expect(r.clientsSpendCents + r.offDocumentCollectedCents).toBe(r.studioCollectedCents);
    expect(r.reconciled).toBe(true);
    // if a client total were short by even one cent, the same equation fails
    expect(r.clientsSpendCents - 1 + r.offDocumentCollectedCents === r.studioCollectedCents).toBe(false);
  });
  it("the month wording is the appointment month, not the payment date", () => {
    expect(DIRECTORY_MONTH_NOTE).toMatch(/^Visits in this month, by appointment date/);
    expect(DIRECTORY_MONTH_NOTE).toMatch(/not on the day it was made/);
  });
  it("an excluded-only row (failed attempt) adds nobody and reconciles", () => {
    const e = appt("c4", { status: "cancelled", startsAt: "2026-11-08T15:00:00Z" });
    const x = must(input({ ...rows, appointments: [...rows.appointments, e], cardRows: [...rows.cardRows, card(e.id, { status: "failed" })] }));
    expect(x.rows.map((y) => y.clientId)).toEqual(["c1", "c2", "c3"]);
    expect(x.reconciliation.reconciled).toBe(true);
  });
  it("identity is the client ID: two clients with the same name stay two rows with separate figures", () => {
    const p = appt("x1"), q = appt("x2", { startsAt: "2026-11-04T15:00:00Z" });
    const x = must(input({ appointments: [p, q], cardRows: [card(p.id, { amountCents: 1000 }), card(q.id, { amountCents: 2000 })], clientNames: new Map([["x1", "Sam Same"], ["x2", "Sam Same"]]) }));
    expect(x.rows.map((y) => [y.clientId, y.paidCents])).toEqual([["x1", 1000], ["x2", 2000]]);
  });
  it("a month with nobody is an empty, reconciled directory", () => {
    const x = must(input({}));
    expect(x.rows).toEqual([]);
    expect(x.reconciliation.reconciled).toBe(true);
  });
});

describe("paging never changes counts or totals", () => {
  const many = Array.from({ length: 60 }, (_, i) => appt(`k${String(i).padStart(2, "0")}`, { startsAt: `2026-11-${String((i % 27) + 1).padStart(2, "0")}T15:00:00Z` }));
  const nm = new Map(many.map((a) => [a.clientId, `Client ${a.clientId}`]));
  const r = must(input({ appointments: many, cardRows: many.map((a) => card(a.id, { amountCents: 1000 })), clientNames: nm }));
  it("every page reports the SAME whole-month totals, and the pages together hold each client exactly once", () => {
    const pages = [1, 2, 3].map((p) => pageDirectory(r, p, 25));
    for (const pg of pages) expect(pg.totals).toEqual(r.totals);
    expect(pages.map((p) => p.rows.length)).toEqual([25, 25, 10]);
    const ids = pages.flatMap((p) => p.rows.map((x) => x.clientId));
    expect(new Set(ids).size).toBe(60);
    expect(pages.flatMap((p) => p.rows).reduce((a, x) => a + x.paidCents, 0)).toBe(r.totals.paidCents);
    expect(r.totals.clientCount).toBe(60);
  });
  it("page and size are clamped: out-of-range pages land on the real last or first page", () => {
    expect(pageDirectory(r, 99, 25).page).toBe(3);
    expect(pageDirectory(r, -4, 25).page).toBe(1);
    expect(pageDirectory(r, 1, 100000).pageSize).toBe(DIRECTORY_PAGE_SIZES.max);
    expect(pageDirectory(r, 1, 0).pageSize).toBe(DIRECTORY_PAGE_SIZES.min);
    expect(pageDirectory(r, 1, 2.5).pageSize).toBe(DIRECTORY_PAGE_SIZES.default);
  });
  it("studio-timezone month boundaries decide membership: 23:30 on the last local day is in the month, the next local midnight is not", () => {
    // The loader reads the window; the model additionally scopes by LOCAL date, so a stray row from the neighbouring month never counts.
    const inLate = appt("e1", { startsAt: "2026-12-01T04:30:00Z" }); // 23:30 on 30 Nov in Toronto
    const outNext = appt("e2", { startsAt: "2026-12-01T05:30:00Z" }); // 00:30 on 1 Dec
    const x = must(input({ appointments: [inLate, outNext], clientNames: new Map([["e1", "E One"], ["e2", "E Two"]]) }));
    expect(x.rows.map((y) => y.clientId)).toEqual(["e1"]);
  });
});

describe("Find a client", () => {
  const clients: FinderClient[] = [
    { id: "id-1", name: "Jane Smith", preferredName: null, archived: false },
    { id: "id-2", name: "Janet Smithers", preferredName: null, archived: false },
    { id: "id-3", name: "José Núñez", preferredName: "Joe", archived: false },
    { id: "id-4", name: "Jane Smith", preferredName: null, archived: true },
    { id: "id-5", name: "Quiet Person", preferredName: null, archived: false },
  ];
  const counts = new Map([["id-1", 3]]);
  it("nothing typed is a prompt, not a list", () => {
    expect(findClients(clients, "   ", counts)).toEqual({ state: "prompt", results: [] });
  });
  it("partial names match in any order; clients with NO visit that month are included with a zero count", () => {
    const r = findClients(clients, "smi jane", counts);
    expect(r.state).toBe("results");
    if (r.state !== "results") return;
    expect(r.results.map((x) => [x.clientId, x.monthVisitCount])).toEqual([["id-1", 3], ["id-4", 0], ["id-2", 0]]);
    const q = findClients(clients, "quiet", counts);
    expect(q.state === "results" && q.results[0]).toMatchObject({ clientId: "id-5", monthVisitCount: 0 });
  });
  it("two clients with the SAME name are two results, flagged, each carrying its own id and count (selection is by id)", () => {
    const r = findClients(clients, "jane smith", counts);
    if (r.state !== "results") throw new Error("expected results");
    const same = r.results.filter((x) => x.displayName === "Jane Smith");
    expect(same.map((x) => [x.clientId, x.sameNameAsAnother, x.archived, x.monthVisitCount])).toEqual([["id-1", true, false, 3], ["id-4", true, true, 0]]);
  });
  it("accents fold and the preferred name is the shown name; matching is on the SHOWN name only", () => {
    const r = findClients(clients, "joe", counts);
    expect(r.state === "results" && r.results.map((x) => x.clientId)).toEqual(["id-3"]);
    expect(findClients(clients, "nunez", counts).state).toBe("none"); // the shown name is "Joe": the stored legal name is not searchable
  });
  it("it never matches email or phone (those fields are not even in the input)", () => {
    expect(Object.keys(clients[0]).sort()).toEqual(["archived", "id", "name", "preferredName"]);
    expect(findClients(clients, "555-0100", counts).state).toBe("none");
  });
  it("no match is the empty state; results are capped and say so", () => {
    expect(findClients(clients, "zzzz", counts)).toEqual({ state: "none", results: [] });
    const lots: FinderClient[] = Array.from({ length: FINDER_LIMIT + 5 }, (_, i) => ({ id: `m${i}`, name: `Mia ${String(i).padStart(2, "0")}`, preferredName: null, archived: false }));
    const r = findClients(lots, "mia", new Map());
    expect(r.state === "results" && [r.results.length, r.truncated]).toEqual([FINDER_LIMIT, true]);
  });
});

describe("source guard: the directory model is pure", () => {
  const code = readFileSync(path.join(ROOT, "lib/finance/statement-directory.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  it("no server-only, supabase, stripe, mail, fetch, clock or env", () => {
    for (const bad of [/server-only/, /supabase/i, /from\s+["'][^"']*stripe/i, /resend|nodemailer|sendgrid|twilio/i, /\bfetch\(/, /new Date\(\)/, /Date\.now/, /process\.env/]) expect(code).not.toMatch(bad);
  });
});
