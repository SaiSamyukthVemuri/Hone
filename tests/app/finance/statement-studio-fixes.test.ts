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
import { studioVisitStatus } from "@/lib/finance/statement-methods";
import { STATEMENT_FRAMING } from "@/lib/finance/statement-copy";
import { formatStatementMoney } from "@/lib/finance/statement-money";
import type { SupabaseClient } from "@supabase/supabase-js";

// The Studio tab, restyled to the approved reference. PRESENTATION ONLY: every figure, sentence and rule is unchanged; these pin what the new layout adds
// (the sage summary card, the method bar, the breakdown behind a disclosure, the paged latest-first visit table) and that none of it can disagree with the
// totals. Synthetic records only.

// The tabs stay visible when the Studio read fails, and a row is not "Paid" when what was collected is below the price the visit was settled against, or
// when nothing was collected. Synthetic records only.
const cash = (cents: number) => ({ kind: "collected_cash" as const, cents });
const card = (cents: number) => ({ kind: "collected_card_session" as const, cents });

describe("studioVisitStatus: derived from the money lines and the price the visit was settled against", () => {
  it("$50 cash against a $100 quote is NOT Paid: it says Payment not confirmed, with the existing reason, and no amount owed", () => {
    expect(studioVisitStatus([cash(5000)], 10000)).toEqual({ label: "Payment not confirmed", tone: "warning", reason: "Part settled; the rest is not confirmed" });
  });
  it("an exact match and an overpayment are Paid", () => {
    expect(studioVisitStatus([cash(10000)], 10000)).toEqual({ label: "Paid", tone: "success" });
    expect(studioVisitStatus([cash(15000)], 10000).label).toBe("Paid");
  });
  it("a recorded $0 collection: No charge when the price is $0; otherwise Payment not confirmed. Never Paid", () => {
    expect(studioVisitStatus([cash(0)], 0)).toEqual({ label: "No charge", tone: "neutral" });
    expect(studioVisitStatus([cash(0)], 10000).label).toBe("Payment not confirmed");
    expect(studioVisitStatus([cash(0)], null).label).toBe("Payment not confirmed");
  });
  it("no quote: Payment recorded (it cannot be said to be paid in full), except one card charge, which is what was charged and covers itself", () => {
    expect(studioVisitStatus([cash(5000)], null)).toEqual({ label: "Payment recorded", tone: "neutral" });
    expect(studioVisitStatus([card(10000)], null).label).toBe("Paid");
    expect(studioVisitStatus([card(10000), cash(2000)], null).label).toBe("Payment recorded");
    expect(studioVisitStatus([card(10000), card(2000)], null).label).toBe("Payment recorded");
  });
  it("money plus a waived amount that covers the quote is Paid; one that does not is Payment not confirmed; a still-owing note beside money is Payment recorded", () => {
    expect(studioVisitStatus([cash(5000), { kind: "waived", cents: 5000 }], 10000).label).toBe("Paid");
    expect(studioVisitStatus([cash(5000), { kind: "waived", cents: 1000 }], 10000).label).toBe("Payment not confirmed");
    expect(studioVisitStatus([cash(5000), { kind: "still_owes_note", cents: null }], 10000).label).toBe("Payment recorded");
  });
  it("a quote of one visit never changes a visit with no money: the adjustment words are unchanged", () => {
    expect(studioVisitStatus([{ kind: "waived", cents: 100 }], 10000).label).toBe("Waived");
    expect(studioVisitStatus([{ kind: "unresolved", cents: null }], 10000).label).toBe("Unresolved");
  });
});

async function renderFix(over: { settlementQuotes?: Record<string, number>; settle?: { appointmentId: string; method: string; amountCents: number; currency: string }[]; card?: StatementCardRow[]; view?: Record<string, unknown>; tabs?: unknown }) {
  const { StatementView } = await import("@/app/(app)/financials/statement/statement-view");
  const statement = buildStatement({
    studioCurrency: "cad",
    appointments: [{ id: "v1", practitionerId: "pract-one", startsAt: "2026-11-03T15:00:00Z" }],
    cardRows: over.card ?? [],
    settlementRows: over.settle ?? [],
    legacyFeeRows: [],
  });
  return renderToStaticMarkup(
    createElement(StatementView as never, {
      view: { access: "granted", ok: true, month: "2026-11", label: "November 2026", timezone: "America/Toronto", startLocal: "2026-11-01", endLocalExclusive: "2026-12-01", statement, visitInfo: { v1: { clientName: "Client v1", serviceName: "Service" } }, practitionerNames: { "pract-one": "Pat Synthetic" }, noPaymentVisits: [], settlementQuotes: over.settlementQuotes ?? {}, ...over.view },
      currency: "cad",
      format: (c: number) => formatStatementMoney(c, "cad"),
      maxMonth: "2026-11",
      tabs: over.tabs,
    }),
  );
}

describe("the row pill in the rendered table", () => {
  it("$50 cash against a $100 settled quote reads Payment not confirmed with the part-settled reason, never Paid", async () => {
    const out = await renderFix({ settle: [{ appointmentId: "v1", method: "paid_cash", amountCents: 5000, currency: "cad" }], settlementQuotes: { v1: 10000 } });
    expect(out).toMatch(/>Payment not confirmed<\/span><span[^>]*>Part settled; the rest is not confirmed<\/span>/);
    expect(out).not.toMatch(/>Paid<\/span>/);
    expect(out).toMatch(/text-right[^"]*"[^>]*>\$50\.00 CAD</); // the amount shown is still what was collected, not a balance
    expect(out).not.toMatch(/\bowed?\b|\bdue\b/i);
  });
  it("the same $50 with no quote reads Payment recorded; an exact $100 of $100 reads Paid; a $0 cash settlement is never Paid", async () => {
    const s = (n: number) => [{ appointmentId: "v1", method: "paid_cash", amountCents: n, currency: "cad" }];
    expect(await renderFix({ settle: s(5000) })).toMatch(/>Payment recorded<\/span>/);
    expect(await renderFix({ settle: s(10000), settlementQuotes: { v1: 10000 } })).toMatch(/>Paid<\/span>/);
    const zero = await renderFix({ settle: s(0), settlementQuotes: { v1: 10000 } });
    expect(zero).not.toMatch(/>Paid<\/span>/);
    expect(zero).toMatch(/>Payment not confirmed<\/span>/);
  });
  it("the totals and the method bar are identical whatever the quote says (the quote words a pill and feeds no figure)", async () => {
    const s = [{ appointmentId: "v1", method: "paid_cash", amountCents: 5000, currency: "cad" }];
    const summary = (h: string) => h.slice(h.indexOf('aria-label="Summary"'), h.indexOf("</section>", h.indexOf('aria-label="Summary"')));
    expect(summary(await renderFix({ settle: s, settlementQuotes: { v1: 10000 } }))).toBe(summary(await renderFix({ settle: s })));
  });
});

describe("a failed Studio read keeps the tabs", () => {
  const tabs = createElement("nav", { "aria-label": "Statements" }, "TABS-STUB");
  it.each(["read_failed", "too_many_appointments", "currency_unknown", "month_out_of_range"])("%s: the error message AND the tabs are rendered", async (reason) => {
    const out = await renderFix({ view: { ok: false, reason }, tabs });
    expect(out).toContain("TABS-STUB");
    expect(out).toMatch(/The statement could not be read|more appointments than|payment currency is not set|outside the range/);
  });
  it("a non-owner gets the refusal and NO tabs (nothing to navigate to)", async () => {
    const out = await renderFix({ view: { access: "refused" }, tabs });
    expect(out).toContain("Only the studio owner can see the money statement.");
    expect(out).not.toContain("TABS-STUB");
  });
  it("the page passes the tabs into the view for every state (source guard)", () => {
    const src = readFileSync("app/(app)/financials/statement/page.tsx", "utf8");
    expect(src).toMatch(/tabs=\{<StatementsTabs active="studio" month=\{month\} \/>\}/);
  });
});

describe("the loader carries the settled quote, and only a clean one", () => {
  type Result = { data: unknown[] | null; error: unknown };
  const okr = (data: unknown[]): Result => ({ data, error: null });
  const recording = (results: Record<string, Result>) =>
    ({
      from: (table: string) => {
        const chain: unknown = new Proxy(() => undefined, { get: (_x, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(results[table]) : () => chain) });
        return chain;
      },
    }) as unknown as SupabaseClient;
  const run = async (settle: unknown[]) => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const a = (id: string) => ({ id, status: "completed", starts_at: "2026-11-03T15:00:00Z", practitioner_id: "p1", service_id: null, clients: null });
    const v = await loadStatementView({ role: "owner" }, { id: "s1", timezone: "America/Toronto" }, "2026-11", "cad", recording({ appointments: okr([a("a1"), a("a2"), a("a3"), a("a4"), a("a5")]), sessions: okr([]), payment_charge_attempts: okr([]), appointment_settlements: okr(settle), manual_fee_charge_attempts: okr([]), visit_bills: okr([]), visit_external_payments: okr([]), payment_refunds: okr([]), payment_refund_reviews: okr([]), services: okr([]), practitioners: okr([]) }));
    if (v.access !== "granted" || !v.ok) throw new Error("expected a granted view");
    return v;
  };
  const row = (id: string, quote: unknown) => ({ appointment_id: id, method: "paid_cash", amount_cents: 5000, currency: "cad", quoted_amount_cents: quote });
  it("keeps a valid quote (including a recorded $0), drops a missing, negative or fractional one, and drops a visit whose live quotes disagree", async () => {
    const v = await run([row("a1", 10000), row("a2", 0), row("a3", null), row("a4", -5), row("a5", 1.5), row("a1", 10000), row("a2", 500), row("a2", 600)]);
    expect(v.settlementQuotes).toEqual({ a1: 10000 });
  });
  it("it changes no total: the statement is identical with and without quotes on the settlements", async () => {
    const withQ = await run([row("a1", 10000)]);
    const without = await run([row("a1", null)]);
    expect(withQ.statement).toEqual(without.statement);
  });
});

// Fidelity pass against the approved reference (heading, explanatory text placement, service, links, dash). Synthetic records only.
const withInfo = { visitInfo: { v1: { clientName: "Client v1", clientId: "client-1", serviceName: "Service", minutes: 30 } } };

describe("heading and the explanatory text", () => {
  it("a breadcrumb and the title 'Monthly statements'; the month lives in the picker and the card, not the title", async () => {
    const out = await renderFix({ view: withInfo });
    expect(out).toMatch(/Business\s*\/\s*Statements/);
    expect(out).toMatch(/<h1[^>]*>Monthly statements<\/h1>/);
    expect(out).not.toContain("Money statement:");
    expect(out).toContain("November 2026 · Total collected");
  });
  it("the period/timezone line and the framing sentence are KEPT, below the table as a footnote, not above the card", async () => {
    const out = await renderFix({ view: withInfo });
    const period = "in the studio&#x27;s timezone (America/Toronto)";
    expect(out).toContain(period);
    expect(out).toContain(STATEMENT_FRAMING);
    const visitsAt = out.indexOf('aria-labelledby="stmt-visits"');
    expect(out.indexOf(period)).toBeGreaterThan(visitsAt);
    expect(out.indexOf(STATEMENT_FRAMING)).toBeGreaterThan(visitsAt);
  });
});

describe("the visit row", () => {
  it("shows the service with its minutes, and the client as a link to their statement for the month", async () => {
    const out = await renderFix({ view: withInfo, settle: [{ appointmentId: "v1", method: "paid_cash", amountCents: 5000, currency: "cad" }] });
    expect(out).toMatch(/>Service<small[^>]*>· 30 min</);
    expect(out).toMatch(/<a [^>]*href="\/financials\/statements\/client-1\?month=2026-11[^"]*"[^>]*>Client v1<\/a>/);
    expect(out).not.toMatch(/Invoice/);
  });
  it("a client with no id is plain text, not a link; no minutes means no '· min' text", async () => {
    const out = await renderFix({ view: { visitInfo: { v1: { clientName: "Client v1", clientId: null, serviceName: "Service", minutes: null } } }, settle: [{ appointmentId: "v1", method: "paid_cash", amountCents: 5000, currency: "cad" }] });
    expect(out).not.toMatch(/<a [^>]*>Client v1<\/a>/);
    expect(out).not.toContain(" min<");
  });
  it("a still-owing visit shows an em dash (read aloud as 'no amount') in the Collected column, never visible 'no amount' text", async () => {
    const out = await renderFix({ view: withInfo, settle: [{ appointmentId: "v1", method: "still_owes", amountCents: 0, currency: "cad" }] });
    expect(out).toMatch(/<span aria-hidden="true">—<\/span><span class="sr-only">no amount<\/span>/);
    const table = out.slice(out.indexOf('aria-labelledby="stmt-visits"'));
    expect(table.slice(0, table.indexOf("</summary>")).match(/no amount/g)?.length).toBe(1); // the one copy is the sr-only text asserted above
  });
  it("no row carries 'Marked still owing (a note, not an amount)' under a pill that already says it", async () => {
    const out = await renderFix({ view: withInfo, settle: [{ appointmentId: "v1", method: "still_owes", amountCents: 0, currency: "cad" }] });
    const visits = out.slice(out.indexOf('aria-labelledby="stmt-visits"'), out.indexOf("</summary>", out.indexOf('aria-labelledby="stmt-visits"')));
    expect(visits).not.toContain("a note, not an amount");
  });
});

describe("visitMinutes and the loader", () => {
  it("whole minutes between start and end; absent when missing, unreadable, or not after the start", async () => {
    const { visitMinutes } = await import("@/lib/finance/statement-read");
    expect(visitMinutes("2026-11-03T15:00:00Z", "2026-11-03T15:30:00Z")).toBe(30);
    expect(visitMinutes("2026-11-03T15:00:00Z", "2026-11-03T16:30:00Z")).toBe(90);
    expect(visitMinutes("2026-11-03T15:00:00Z", null)).toBeNull();
    expect(visitMinutes("2026-11-03T15:00:00Z", "nonsense")).toBeNull();
    expect(visitMinutes("2026-11-03T15:00:00Z", "2026-11-03T15:00:00Z")).toBeNull();
    expect(visitMinutes("2026-11-03T15:00:00Z", "2026-11-03T14:00:00Z")).toBeNull();
  });
  it("visitInfo carries the client id and minutes from the SAME appointments read; it changes no figure", async () => {
    const { loadStatementView } = await import("@/lib/finance/statement-read");
    const calls: string[] = [];
    const client = {
      from: (table: string) => {
        const results: Record<string, { data: unknown[]; error: null }> = {
          appointments: { data: [{ id: "a1", starts_at: "2026-11-03T15:00:00Z", ends_at: "2026-11-03T16:00:00Z", client_id: "cl-1", practitioner_id: "p1", service_id: null, clients: { name: "Synthetic", preferred_name: null } }], error: null },
          sessions: { data: [], error: null }, payment_charge_attempts: { data: [], error: null }, appointment_settlements: { data: [], error: null }, visit_bills: { data: [], error: null }, visit_external_payments: { data: [], error: null }, payment_refunds: { data: [], error: null }, payment_refund_reviews: { data: [], error: null }, manual_fee_charge_attempts: { data: [], error: null }, services: { data: [], error: null }, practitioners: { data: [], error: null },
        };
        const chain: unknown = new Proxy(() => undefined, { get: (_x, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(results[table]) : (...a: unknown[]) => { if (prop === "select" && table === "appointments") calls.push(String(a[0])); return chain; }) });
        return chain;
      },
    } as unknown as SupabaseClient;
    const v = await loadStatementView({ role: "owner" }, { id: "s1", timezone: "America/Toronto" }, "2026-11", "cad", client);
    if (v.access !== "granted" || !v.ok) throw new Error("expected a granted view");
    expect(v.visitInfo.a1).toMatchObject({ clientId: "cl-1", minutes: 60, clientName: "Synthetic" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("ends_at");
    expect(calls[0]).toContain("client_id");
  });
});

describe("small fidelity items", () => {
  it("at the latest month the next arrow is drawn DISABLED: not a link, hidden from assistive technology; earlier months still link to it", async () => {
    const out = await renderFix({ view: withInfo });
    expect(out).toMatch(/<span aria-hidden="true" class="[^"]*opacity-35[^"]*">›<\/span>/);
    expect(out).not.toContain("Next month");
  });
  it("under the client on a phone the row shows just the length ('30 min'), falling back to the service name when no length is known", async () => {
    const phone = (out: string) => [...out.matchAll(/<span class="block text-xs text-fg-muted min-\[781px\]:hidden">([^<]*)<\/span>/g)].map((m) => m[1]);
    const settle = [{ appointmentId: "v1", method: "paid_cash", amountCents: 5000, currency: "cad" }];
    expect(phone(await renderFix({ view: withInfo, settle }))).toEqual(["30 min"]);
    expect(phone(await renderFix({ view: { visitInfo: { v1: { clientName: "Client v1", clientId: null, serviceName: "Service", minutes: null } } }, settle }))).toEqual(["Service"]);
  });
  it("the Statements page keeps its own content area on the white ground (no tint) and leaves the shell alone (source guard)", () => {
    const src = readFileSync("app/(app)/financials/statement/page.tsx", "utf8");
    expect(src).toMatch(/className="bg-surface min-\[1140px\]:-mx-\[45px\]"/);
  });
});

describe("an unresolved money line wins over everything else in the pill", () => {
  const unresolved = { kind: "unresolved" as const, cents: null };
  const UNRESOLVED = { label: "Unresolved", tone: "warning", reason: "A payment or refund is unresolved" };
  it("a collected card session beside an unresolved line is Unresolved, never Paid (with or without a quote)", () => {
    expect(studioVisitStatus([card(10000), unresolved])).toEqual(UNRESOLVED);
    expect(studioVisitStatus([card(10000), unresolved], 10000)).toEqual(UNRESOLVED);
    expect(studioVisitStatus([cash(5000), unresolved], 5000)).toEqual(UNRESOLVED);
  });
  it("a refunded fee or session beside an unresolved line is Unresolved, never Refunded in full", () => {
    expect(studioVisitStatus([{ kind: "refunded_card_fee", cents: 2500 }, unresolved])).toEqual(UNRESOLVED);
    expect(studioVisitStatus([{ kind: "refunded_card_session", cents: 10000 }, unresolved])).toEqual(UNRESOLVED);
  });
  it("unresolved alone, and beside a waiver or a still-owing note, is Unresolved", () => {
    expect(studioVisitStatus([unresolved])).toEqual(UNRESOLVED);
    expect(studioVisitStatus([unresolved, { kind: "waived", cents: 100 }])).toEqual(UNRESOLVED);
    expect(studioVisitStatus([unresolved, { kind: "still_owes_note", cents: null }])).toEqual(UNRESOLVED);
  });
  it("without an unresolved line nothing changes: collected stays Paid, a lone refund stays Refunded in full", () => {
    expect(studioVisitStatus([card(10000)]).label).toBe("Paid");
    expect(studioVisitStatus([{ kind: "refunded_card_fee", cents: 2500 }]).label).toBe("Refunded in full");
  });
});
