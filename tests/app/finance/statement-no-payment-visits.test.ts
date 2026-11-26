import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { buildStatement, type StatementCardRow } from "@/lib/finance/statement";
import { STATEMENT_MONTH_NOTICE, STATEMENT_NO_TOTAL, STATEMENT_UNNAMED_PRACTITIONER } from "@/lib/finance/statement-copy";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// HON-64 Slice A review findings, pinned by rendering the real view with synthetic data.
const row = (over: Partial<StatementCardRow>): StatementCardRow => ({
  appointmentId: "a1",
  chargeReason: "session_payment",
  status: "succeeded",
  amountCents: 12345,
  currency: "cad",
  refundStatus: null,
  refundAmountCents: null,
  providerRefundStatus: null,
  stripeRefundId: null,
  cumulativeFullRefundVerified: false,
  stripeLivemode: true,
  ...over,
});
const fmt = (c: number) => `$${Math.trunc(c / 100)}.${String(c % 100).padStart(2, "0")} CAD`;

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: Record<string, unknown>) => createElement("a", { href: String(href), ...rest }, children as never),
  useLinkStatus: () => ({ pending: false }),
}));
import { formatStatementMoney } from "@/lib/finance/statement-money";
import type { SupabaseClient } from "@supabase/supabase-js";

// The Studio tab, restyled to the approved reference. PRESENTATION ONLY: every figure, sentence and rule is unchanged; these pin what the new layout adds
// (the sage summary card, the method bar, the breakdown behind a disclosure, the paged latest-first visit table) and that none of it can disagree with the
// totals. Synthetic records only.

// PR-D: the Studio visit list also shows COMPLETED visits that have no payment recorded, as the approved design does. A LISTING ONLY: no amount, in no total,
// nothing implied as owed. Which appointments qualify is the statement's existing visit rule (a completed treatment is a visit; cancelled, no-show and
// not-yet-completed bookings are not), in the same window and behind the same owner gate. Synthetic records only.
type Result = { data: unknown[] | null; error: unknown };
type Call = { table: string; method: string; args: unknown[] };
function recording(results: Record<string, Result>) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => {
      const chain: unknown = new Proxy(() => undefined, {
        get: (_x, prop) => {
          if (prop === "then") return (res: (v: unknown) => void) => res(results[table]);
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args });
            return chain;
          };
        },
      });
      return chain;
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}
const okr = (data: unknown[]): Result => ({ data, error: null });
const appt = (id: string, status: string, day = 3) => ({ id, status, starts_at: `2026-11-${String(day).padStart(2, "0")}T15:00:00Z`, practitioner_id: "p1", service_id: null, clients: { name: "Synthetic Client", preferred_name: null } });
const studio = { id: "s1", timezone: "America/Toronto" };
const tables = (appts: unknown[], money: { card?: unknown[]; settle?: unknown[] } = {}): Record<string, Result> => ({
  appointments: okr(appts),
  sessions: okr([]),
  payment_charge_attempts: okr(money.card ?? []),
  appointment_settlements: okr(money.settle ?? []),
  manual_fee_charge_attempts: okr([]),
  services: okr([]),
  practitioners: okr([]),
});
const cardRow = (appointmentId: string, over: Record<string, unknown> = {}) => ({
  id: `c-${appointmentId}`, charge_reason: "session_payment", status: "succeeded", amount_cents: 10000, currency: "cad", refund_status: null, refund_amount_cents: null,
  stripe_refund_status: null, stripe_refund_id: null, stripe_charge_refund_event_id: null, stripe_livemode: true, appointment_id: appointmentId, session_id: null, ...over,
});
const load = async (t: Record<string, Result>) => {
  const { loadStatementView } = await import("@/lib/finance/statement-read");
  const r = recording(t);
  const view = await loadStatementView({ role: "owner" }, studio, "2026-11", "cad", r.client);
  return { view, calls: r.calls };
};

describe("the loader lists ONLY completed visits with no money line of any kind", () => {
  const appts = [
    appt("done-none", "completed", 2),
    appt("done-card", "completed", 3),
    appt("done-owes", "completed", 4),
    appt("done-usd", "completed", 5),
    appt("conf", "confirmed", 6),
    appt("cancel", "cancelled", 7),
    appt("noshow", "no_show", 8),
    appt("odd", "something_else", 9),
    appt("nostatus", "", 10),
  ];
  const money = { card: [cardRow("done-card"), cardRow("done-usd", { currency: "usd" })], settle: [{ appointment_id: "done-owes", method: "still_owes", amount_cents: 0, currency: "cad" }] };
  it("lists done-none only: a visit with ANY money line (collected, a still-owing note, or one counted in no total) is already in the statement and not repeated; cancelled, no-show, confirmed and unknown statuses are not visits", async () => {
    const { view } = await load(tables(appts, money));
    if (!view.access || view.access !== "granted" || !view.ok) throw new Error("expected a granted view");
    expect(view.noPaymentVisits.map((v) => v.appointmentId)).toEqual(["done-none"]);
    expect(view.statement.visits.map((v) => v.appointmentId).sort()).toEqual(["done-card", "done-owes", "done-usd"]);
    expect(view.noPaymentVisits[0]).toEqual({ appointmentId: "done-none", startsAt: "2026-11-02T15:00:00Z", practitionerId: "p1" });
  });
  it("the statement is IDENTICAL with and without these visits: totals, methods, every line, the reconciliation", async () => {
    const withRows = await load(tables(appts, money));
    const without = await load(tables(appts.filter((a) => a.id !== "done-none"), money));
    if (!withRows.view.access || withRows.view.access !== "granted" || !withRows.view.ok || without.view.access !== "granted" || !without.view.ok) throw new Error("expected granted views");
    expect(withRows.view.statement).toEqual(without.view.statement);
    expect(without.view.noPaymentVisits).toEqual([]);
  });
  it("completed visits with no money at all, and nothing else in the month: listed, with an empty statement", async () => {
    const { view } = await load(tables([appt("only", "completed")]));
    if (view.access !== "granted" || !view.ok) throw new Error("expected a granted view");
    expect(view.noPaymentVisits.map((v) => v.appointmentId)).toEqual(["only"]);
    expect(view.statement.all.collectedCents).toBe(0);
    expect(view.statement.visits).toEqual([]);
  });
});

describe("the same visit-date window and the same owner gate as the rest of the statement", () => {
  it("the appointments are read ONCE, bounded by the studio-local month on the visit's start (EDT start of Nov 1, EST start of Dec 1)", async () => {
    const { calls } = await load(tables([appt("x", "completed")]));
    const reads = calls.filter((c) => c.table === "appointments");
    expect(reads.find((c) => c.method === "gte")?.args).toEqual(["starts_at", "2026-11-01T04:00:00.000Z"]);
    expect(reads.find((c) => c.method === "lt")?.args).toEqual(["starts_at", "2026-12-01T05:00:00.000Z"]);
    expect(reads.filter((c) => c.method === "select").length).toBe(1);
    expect(reads.find((c) => c.method === "eq")?.args).toEqual(["studio_id", "s1"]);
  });
  it("a non-owner is refused before any read, so no visit with no payment is ever returned to them", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const r = recording(tables([appt("x", "completed")]));
    expect(await loadStatementView({ role: "practitioner" }, studio, "2026-11", "cad", r.client)).toEqual({ access: "refused" });
    expect(await loadStatementView({ role: "receptionist" }, studio, "2026-11", "cad", r.client)).toEqual({ access: "refused" });
    expect(r.calls).toEqual([]);
  });
  it("the nothing-in-the-month shortcut and a failed read return no list (never a partial one)", async () => {
    const empty = await load(tables([]));
    if (empty.view.access !== "granted" || !empty.view.ok) throw new Error("expected a granted view");
    expect(empty.view.noPaymentVisits).toEqual([]);
    const failed = await load({ ...tables([appt("x", "completed")]), appointments: { data: null, error: { message: "boom" } } });
    expect(failed.view).toEqual({ access: "granted", ok: false, reason: "read_failed" });
  });
});

const noPay = (id: string, day: number) => ({ appointmentId: id, startsAt: `2026-11-${String(day).padStart(2, "0")}T15:00:00Z`, practitionerId: "pract-one" });
const moneyStatement = () =>
  buildStatement({
    studioCurrency: "cad",
    appointments: [{ id: "m1", practitionerId: "pract-one", startsAt: "2026-11-03T15:00:00Z" }, { id: "m2", practitionerId: "pract-one", startsAt: "2026-11-05T15:00:00Z" }],
    cardRows: [row({ appointmentId: "m1", amountCents: 120000 }), row({ appointmentId: "m2", amountCents: 30000 })],
    settlementRows: [],
    legacyFeeRows: [],
  });
async function renderRows(noPayment: ReturnType<typeof noPay>[], page = 1) {
  const { StatementView } = await import("@/app/(app)/financials/statement/statement-view");
  const statement = moneyStatement();
  const visitInfo: Record<string, { clientName: string; serviceName: string | null }> = {};
  for (const v of statement.visits) visitInfo[v.appointmentId] = { clientName: `Client ${v.appointmentId}`, serviceName: "Service" };
  for (const n of noPayment) visitInfo[n.appointmentId] = { clientName: `Client ${n.appointmentId}`, serviceName: "Service" };
  return renderToStaticMarkup(
    createElement(StatementView as never, {
      view: { access: "granted", ok: true, month: "2026-11", label: "November 2026", timezone: "America/Toronto", startLocal: "2026-11-01", endLocalExclusive: "2026-12-01", statement, visitInfo, practitionerNames: { "pract-one": "Pat Synthetic" }, settlementQuotes: {}, noPaymentVisits: noPayment },
      currency: "cad",
      format: (c: number) => formatStatementMoney(c, "cad"),
      maxMonth: "2026-11",
      page,
      studioName: "Studio One",
    }),
  );
}
const region = (h: string, from: string, to: string) => h.slice(h.indexOf(from), h.indexOf(to, h.indexOf(from)));

describe("the table row says only that no payment is recorded", () => {
  it("label 'No payment recorded' in the neutral pill, an em dash for the amount, and NO dollar figure, owed or due wording anywhere in the visit table", async () => {
    const out = await renderRows([noPay("np1", 4)]);
    const visits = region(out, 'aria-labelledby="stmt-visits"', "</section>");
    const row1 = region(visits, "Client np1", "</details>");
    expect(row1).toMatch(/bg-status-neutral-surface[^"]*"[^>]*>No payment recorded</);
    expect(row1).toMatch(/<span aria-hidden="true">—<\/span><span class="sr-only">no amount<\/span>/);
    expect(row1).not.toMatch(/\$\d/);
    expect(row1).toContain("No payment recorded for this visit.");
    expect(visits).not.toMatch(/\bowed?\b|\bowing\b|\bdue\b|balance|outstanding|unpaid/i);
    expect(out).not.toMatch(/\$0\.00 CAD<\/span><\/summary>/);
  });
  it("the table says these visits are listed without an amount and are in no total", async () => {
    expect(await renderRows([noPay("np1", 4)])).toContain("Completed visits with no payment recorded are listed without an amount. They are not in any total above.");
    expect(await renderRows([])).not.toContain("listed without an amount");
  });
  it("they are in the table (latest first, paged with the others) and counted in the pager, but NOT in the summary's count of visits with recorded money", async () => {
    const out = await renderRows([noPay("np1", 4), noPay("np2", 9)]);
    const shown = [...out.matchAll(/Client ((?:np|m)\d)/g)].map((m) => m[1]);
    expect(shown).toEqual(["np2", "m2", "np1", "m1"]);
    expect(region(out, 'aria-label="Summary"', "</section>")).toContain("2 visits with recorded money");
  });
});

describe("the summary, the method bar and the breakdown are identical with and without these rows", () => {
  it("byte-identical summary card and full breakdown, with 0, 1 and 12 no-payment visits (12 spills onto page 2 and still cannot move a figure)", async () => {
    const base = await renderRows([]);
    const summary = (h: string) => region(h, 'aria-label="Summary"', "</section>");
    const breakdown = (h: string) => region(h, "<summary", "</details>");
    for (const n of [1, 12]) {
      const rows = Array.from({ length: n }, (_, i) => noPay(`np${i + 1}`, 10 + (i % 15)));
      const out = await renderRows(rows);
      expect(summary(out)).toBe(summary(base));
      expect(breakdown(out)).toBe(breakdown(base));
    }
    expect(summary(base)).toMatch(/\$1,500\.00/);
  });
  it("the pager pages over the merged list", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => noPay(`np${i + 1}`, 10 + i));
    const p1 = await renderRows(rows, 1);
    const p2 = await renderRows(rows, 2);
    expect(p1).toContain("1–8 of 10");
    expect(p2).toContain("9–10 of 10");
    expect([...p2.matchAll(/Client ((?:np|m)\d)/g)].map((m) => m[1])).toEqual(["m2", "m1"]);
  });
});

// Q: what happens when the appointments read reaches its row cap. The statement FAILS CLOSED at the cap (no list at all, the existing "too many
// appointments" message), so a partial list of visits with no payment can never render, and never silently short.
describe("at the appointments row cap nothing partial is ever listed", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => appt(`a${i}`, "completed", 3));
  it("999 appointments are read in full (listed); 1000 or more return the 'too many appointments' error with NO visits and NO no-payment list", async () => {
    const ok = await load(tables(many(999)));
    if (ok.view.access !== "granted" || !ok.view.ok) throw new Error("expected a granted view");
    expect(ok.view.noPaymentVisits).toHaveLength(999);
    for (const n of [1000, 1001]) {
      const { view } = await load(tables(many(n)));
      expect(view).toEqual({ access: "granted", ok: false, reason: "too_many_appointments" });
      expect("noPaymentVisits" in view).toBe(false);
    }
  });
  it("the error screen renders the existing message and no 'No payment recorded' row, no table, no count", async () => {
    const { StatementView } = await import("@/app/(app)/financials/statement/statement-view");
    const out = renderToStaticMarkup(createElement(StatementView as never, { view: { access: "granted", ok: false, reason: "too_many_appointments" }, currency: "cad", format: (c: number) => formatStatementMoney(c, "cad") }));
    expect(out).toContain("more appointments than this statement can read exactly");
    expect(out).not.toMatch(/No payment recorded|<table|stmt-visits|visits with recorded money/);
  });
  it("the read asks for a bounded number of rows (the cap) so the fail-closed check is reachable (source guard)", () => {
    const src = readFileSync("lib/finance/statement-read.ts", "utf8");
    expect(src).toMatch(/\.limit\(APPT_CAP\)/);
    expect(src).toMatch(/appts\.length >= APPT_CAP\) return \{ access: "granted", ok: false, reason: "too_many_appointments" \}/);
  });
});

describe("the empty-money sentence never contradicts a table of no-payment rows", () => {
  const emptyMoney = async (noPayment: ReturnType<typeof noPay>[]) => {
    const { StatementView } = await import("@/app/(app)/financials/statement/statement-view");
    const statement = buildStatement({ studioCurrency: "cad", appointments: [], cardRows: [], settlementRows: [], legacyFeeRows: [] });
    const visitInfo: Record<string, { clientName: string; clientId: string | null; serviceName: string | null; minutes: number | null }> = {};
    for (const n of noPayment) visitInfo[n.appointmentId] = { clientName: `Client ${n.appointmentId}`, clientId: null, serviceName: null, minutes: null };
    return renderToStaticMarkup(createElement(StatementView as never, { view: { access: "granted", ok: true, month: "2026-11", label: "November 2026", timezone: "America/Toronto", startLocal: "2026-11-01", endLocalExclusive: "2026-12-01", statement, visitInfo, practitionerNames: {}, settlementQuotes: {}, noPaymentVisits: noPayment }, currency: "cad", format: (c: number) => formatStatementMoney(c, "cad"), maxMonth: "2026-11" }));
  };
  it("with no-payment rows the sentence says no visit has recorded money AND that completed visits without a payment are listed below, above a table that has them", async () => {
    const out = await emptyMoney([noPay("np1", 4)]);
    expect(out).toContain("No visit this month has recorded money. Completed visits without a payment are listed below.");
    expect(out).not.toContain("No visit has recorded money this month.");
    expect(out.indexOf("are listed below")).toBeLessThan(out.indexOf("Client np1"));
    expect(out).toContain("No payment recorded");
  });
  it("with no no-payment rows the original sentence is unchanged and no table renders", async () => {
    const out = await emptyMoney([]);
    expect(out).toContain("No visit has recorded money this month.");
    expect(out).not.toContain("listed below");
    expect(out).not.toMatch(/Client np|No payment recorded/);
  });
});
