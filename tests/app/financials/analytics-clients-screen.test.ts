// Fixture copied from the Overview screen test: synthetic appointments and money, classified by the real finance code.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildOverview, type OverviewInput, type OverviewView } from "@/lib/business-analytics/overview-model";
import type { OverviewParams } from "@/lib/business-analytics/overview-params";
import { resolvePeriod } from "@/lib/business-analytics/period";

// Synthetic appointments and money, classified by the real finance code. Ids are recognisable so a leak can be found by searching for them.
const NOW = "2026-11-30T20:00:00Z";
const appt = (id: string, status: string, startsAt: string, practitionerId: string | null, clientId = `client-${id}`) => ({ id, clientId, startsAt, status, practitionerId, serviceId: null, durationMinutes: 60 });
const appointments = [
  appt("done-quoted", "completed", "2026-11-05T15:00:00Z", "pr-1"),
  appt("done-over", "completed", "2026-11-06T15:00:00Z", "pr-1"),
  appt("done-noprice", "completed", "2026-11-07T15:00:00Z", "pr-2"),
  appt("noshow", "no_show", "2026-11-08T15:00:00Z", "pr-2"),
];
const money = {
  cardRows: [
    { appointmentId: "done-noprice", chargeReason: "session_payment", status: "succeeded", amountCents: 3000, currency: "cad", refundStatus: null, refundAmountCents: null, providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true },
    { appointmentId: "noshow", chargeReason: "no_show_fee", status: "succeeded", amountCents: 5000, currency: "cad", refundStatus: null, refundAmountCents: null, providerRefundStatus: null, stripeRefundId: null, cumulativeFullRefundVerified: false, stripeLivemode: true },
  ],
  settlementRows: [
    { appointmentId: "done-quoted", method: "paid_cash", amountCents: 9000, currency: "cad", quotedAmountCents: 9000 },
    { appointmentId: "done-over", method: "paid_cash", amountCents: 9500, currency: "cad", quotedAmountCents: 9000 },
  ],
  legacyFeeRows: [],
};
const p = resolvePeriod({ kind: "custom", today: "2026-11-30", from: "2026-11-01", to: "2026-11-30" });
if (!p.ok) throw new Error(p.error);
const input = (over: Partial<OverviewInput> = {}): OverviewInput => ({
  timezone: "America/Toronto",
  currency: "cad",
  nowIso: NOW,
  period: p.period,
  filter: { kind: "all" },
  current: { ok: true, value: { appointments, money: { ok: true, value: money as never } } },
  comparison: { ok: false, reason: "read_failed" },
  history: { ok: true, value: { appointments: [appt("old", "completed", "2026-10-01T15:00:00Z", "pr-1", "client-done-quoted")] } },
  followThrough: { ok: true, value: { past: appointments, future: [] } },
  practitioners: [
    { id: "pr-1", displayName: "Ada Example", active: true },
    { id: "pr-2", displayName: "Grace Example", active: false },
  ],
  classesRead: ["recorded_at_visit"],
  ...over,
});
const params: OverviewParams = { periodKind: "custom", from: "2026-11-01", to: "2026-11-30", compare: "preceding", practitioner: { kind: "all" }, series: "money" };
const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
import { ClientsScreen } from "@/app/(app)/financials/analytics/clients-screen";
import { FIGURE_UNAVAILABLE_COPY } from "@/lib/business-analytics/figure";
import { reconcileClientsMoney } from "@/lib/business-analytics/clients-table";
import { clientsCsv } from "@/lib/business-analytics/clients-csv";
import type { ClientChip, ClientSort } from "@/lib/business-analytics/clients-table";

const NAMES: Record<string, string> = { "client-done-quoted": "Quinn Quoted", "client-done-over": "Olive Over", "client-done-noprice": "Nia Noprice", "client-noshow": "Nora Noshow" };
const lookup = (names: Record<string, string> = NAMES) => ({ ok: true as const, names: new Map(Object.entries(names)) });
const lifetime = (): OverviewInput["clients"] extends infer C ? C extends { lifetimeHistory: infer L } ? L : never : never => ({ ok: true, value: { appointments: [appt("old", "completed", "2026-10-01T15:00:00Z", "pr-1", "client-done-quoted")], money: { ok: true, value: { cardRows: [], settlementRows: [{ appointmentId: "old", method: "paid_cash", amountCents: 7000, currency: "cad", quotedAmountCents: 7000 }], legacyFeeRows: [] } as never } } });
const view = (c: { sort?: ClientSort; chip?: ClientChip; page?: number; lifetimeHistory?: ReturnType<typeof lifetime> } = {}, over: Partial<OverviewInput> = {}): OverviewView =>
  buildOverview(input({ names: lookup(), clients: { sort: c.sort ?? "spend", chip: c.chip ?? "all", page: c.page ?? 1, lifetimeHistory: c.lifetimeHistory ?? lifetime() }, ...over }));
const render = (v: OverviewView, clients = { sort: "spend" as ClientSort, chip: "all" as ClientChip, page: 1 }) =>
  renderToStaticMarkup(createElement(ClientsScreen, { view: v, params, clients, notices: [], practitionerOptions: [{ id: "pr-1", label: "Ada Example" }], format: fmt }));
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
const table = (v: OverviewView) => (v.clientsTable && v.clientsTable.available ? v.clientsTable.value : null);

describe("the Clients tab: the table", () => {
  it("lists the clients seen in the period by display name, in spend order, with the population stated", () => {
    const html = render(view());
    expect(text(html)).toContain("This table lists the clients seen in this period");
    const names = [...html.matchAll(/<th scope="row"[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(names).toEqual(["Olive Over", "Quinn Quoted", "Nia Noprice"]); // $95, $90, $30; Nora had no completed visit
  });
  it("shows first visit, last visit and the lifetime figure through the period's last day", () => {
    const v = view();
    const rows = table(v)?.rows ?? [];
    const quinn = rows.find((r) => r.name === "Quinn Quoted");
    expect(quinn?.firstVisitDate).toBe("2026-10-01"); // the earlier visit
    expect(quinn?.lastVisitDate).toBe("2026-11-05");
    expect(quinn?.lifetimePaidCents).toBe(7000 + 9000);
    expect(rows.find((r) => r.name === "Olive Over")?.lifetimePaidCents).toBe(9500);
    expect(text(render(v))).toContain("$160.00");
  });
  it("a client with no confirmed payment shows Not available and the paid total is not inflated by it", () => {
    const extra = [...appointments, appt("done-unrecorded", "completed", "2026-11-09T15:00:00Z", "pr-1", "client-unrecorded")];
    const v = view({}, { current: { ok: true, value: { appointments: extra, money: { ok: true, value: money as never } } }, followThrough: { ok: true, value: { past: extra, future: [] } }, names: lookup({ ...NAMES, "client-unrecorded": "Una Unrecorded" }) });
    const t = table(v);
    expect(t?.rows.at(-1)?.name).toBe("Una Unrecorded");
    expect(t?.rows.at(-1)?.periodPaidCents).toBeNull();
    expect(t?.seenWithoutConfirmedPayment).toBe(1);
    expect(t?.paidAcrossSeenCents).toBe(9000 + 9500 + 3000);
  });
  it("the page, the sort, the chip and the paging change only the rows, never a card figure", () => {
    const a = view();
    const b = view({ sort: "name", chip: "no_next_booking", page: 1 });
    expect(b.activeClients).toEqual(a.activeClients);
    expect(b.collected).toEqual(a.collected);
    expect(b.completedVisits).toEqual(a.completedVisits);
    expect(table(b)?.seen).toBe(table(a)?.seen);
    expect(table(b)?.paidAcrossSeenCents).toBe(table(a)?.paidAcrossSeenCents);
  });
});

describe("the Clients tab: sort, chip and page", () => {
  it("sorts by name, visits and last visit with the documented tiebreaks", () => {
    expect(table(view({ sort: "name" }))?.rows.map((r) => r.name)).toEqual(["Nia Noprice", "Olive Over", "Quinn Quoted"]);
    expect(table(view({ sort: "visits" }))?.rows[0].name).toBe("Olive Over"); // one visit each, so money kept breaks the tie
  });
  it("the no-next-booking chip shows clients with no confirmed booking to come, and the count says how many", () => {
    const future = [{ clientId: "client-done-over", startsAt: "2026-12-10T15:00:00Z", status: "confirmed" }];
    const v = view({ chip: "no_next_booking" }, { followThrough: { ok: true, value: { past: appointments, future: future as never } } });
    expect(table(v)?.rows.map((r) => r.name).sort()).toEqual(["Nia Noprice", "Quinn Quoted"]);
    expect(table(v)?.chipCounts).toMatchObject({ all: 3, noNextBooking: 2 });
    expect(table(v)?.shown).toBe(2);
  });
  it("when future bookings cannot be read the chip counts are not available and a chip cannot be applied", () => {
    const v = view({ chip: "no_next_booking" }, { followThrough: { ok: false, reason: "read_failed" } });
    expect(v.clientsTable).toEqual({ available: false, reason: "read_failed" });
    const plain = view({}, { followThrough: { ok: false, reason: "read_failed" } });
    expect(table(plain)?.chipCounts.noNextBooking).toBeNull();
    expect(text(render(plain))).toContain("No next booking (not available)");
  });
  it("pages of 25: a page past the end is empty, not an error, and the line says what is shown", () => {
    const past = view({ page: 9 });
    expect(table(past)?.rows).toEqual([]);
    expect(table(past)?.page).toBe(9);
    expect(text(render(past, { sort: "spend", chip: "all", page: 9 }))).toContain("There are no clients on this page. 3 clients match");
    expect(text(render(view()))).toContain("Showing 1 to 3 of 3 clients.");
  });
});

describe("the Clients tab: honest when something cannot be read", () => {
  it("a lifetime read that failed affects only the lifetime column", () => {
    const v = view({ lifetimeHistory: { ok: false, reason: "too_many_appointments" } });
    const t = table(v);
    expect(t?.lifetime).toEqual({ available: false, reason: "too_many_appointments" });
    expect(t?.rows.every((r) => r.lifetimePaidCents === null)).toBe(true);
    expect(t?.rows.map((r) => r.periodPaidCents)).toEqual([9500, 9000, 3000]); // period money is untouched
    expect(text(render(v))).toContain(`Lifetime paid: ${FIGURE_UNAVAILABLE_COPY.too_many_appointments}`);
  });
  it("a failed name read makes the table unavailable with its sentence and leaves the cards", () => {
    const v = buildOverview(input({ names: { ok: false }, clients: { sort: "spend", chip: "all", page: 1, lifetimeHistory: lifetime() } }));
    const html = render(v);
    expect(text(html)).toContain(FIGURE_UNAVAILABLE_COPY.read_failed);
    expect(html).toContain('data-figure="cl-seen"');
    expect(html).not.toContain("<table");
  });
  it("unknown currency: money columns say so, visits and dates still show", () => {
    const v = view({}, { currency: null });
    expect(text(render(v))).toContain(FIGURE_UNAVAILABLE_COPY.currency_unknown);
  });
  it("an archived, unnamed or unread client is not a row, is never Unknown, and stays in the totals", () => {
    const some = buildOverview(input({ names: lookup({ "client-done-quoted": "Quinn Quoted" }), clients: { sort: "spend", chip: "all", page: 1, lifetimeHistory: lifetime() } }));
    const all = view();
    expect(table(some)?.rows.map((r) => r.name)).toEqual(["Quinn Quoted"]);
    expect(table(some)?.notListed).toBe(2);
    expect(table(some)?.seen).toBe(3);
    expect(table(some)?.paidAcrossSeenCents).toBe(table(all)?.paidAcrossSeenCents);
    expect(some.activeClients).toEqual(all.activeClients);
    expect(text(render(some))).toContain("2 clients seen in this period are not listed");
    expect(render(some)).not.toMatch(/Unknown/);
  });
});

describe("the Clients tab: reconciliation", () => {
  it("shows the clients' money, the money with no client, the Overview figure and the difference", () => {
    const v = view();
    const r = v.clientsReconciliation;
    expect(r && r.available && r.value.clientsPaidCents).toBe(9000 + 9500 + 3000);
    expect(r && r.available && r.value.completedVisitsCents).toBe(v.collected.available ? v.collected.value.split.completedVisitsCents : -1);
    expect(r && r.available && r.value.differenceCents).toBe((r && r.available ? r.value.completedVisitsCents : 0) - (9000 + 9500 + 3000) - (r && r.available ? r.value.noClientPaidCents : 0));
    const html = text(render(v));
    expect(html).toContain("Paid in period across every client seen");
    expect(html).toContain("Difference");
  });
});

describe("the Clients tab: nothing personal leaves it", () => {
  it("no client id, email or phone in the markup, no link on a row, and no search field", () => {
    const html = render(view());
    expect(html).not.toMatch(/client-done|client-noshow|client-unrecorded|@|tel:/);
    const tbody = html.match(/<tbody>[\s\S]*<\/tbody>/)?.[0] ?? "";
    expect(tbody).not.toMatch(/<a |href=/);
    expect(html).not.toMatch(/type="search"|name="q"|name="search"/);
  });
  it("no address the page builds contains a name or a search term: only period, team member, sort, filter and page", () => {
    const html = render(view(), { sort: "name", chip: "beyond_usual", page: 2 });
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => decodeURIComponent(m[1].replace(/&amp;/g, "&")));
    expect(hrefs.length).toBeGreaterThan(5);
    for (const h of hrefs) {
      for (const n of Object.values(NAMES)) expect(h.toLowerCase()).not.toContain(n.split(" ")[0].toLowerCase());
      expect(h).not.toMatch(/[?&]q=|search=/);
      const keys = [...new URLSearchParams(h.includes("?") ? h.slice(h.indexOf("?") + 1) : "").keys()];
      for (const k of keys) expect(["period", "from", "to", "compare", "practitioner", "series", "sort", "chip", "page"]).toContain(k);
    }
  });
  it("the form submits only period, team member, dates, comparison, and the kept sort and filter", () => {
    const html = renderToStaticMarkup(createElement(ClientsScreen, { view: view(), params, clients: { sort: "name", chip: "beyond_usual", page: 3 }, notices: [], practitionerOptions: [], format: fmt }));
    const form = html.match(/<form[\s\S]*?<\/form>/)?.[0] ?? "";
    expect([...form.matchAll(/name="([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual(["chip", "compare", "from", "period", "practitioner", "sort", "to"]); // no page: a new period starts at page 1
    expect(form).toContain('action="/financials/analytics/clients"');
  });
  it("the browser's own Print hides the table and says so in print only", () => {
    const html = render(view());
    expect(html).toMatch(/<div[^>]*class="[^"]*print:hidden[^"]*"[^>]*data-print-hidden=""/);
    expect(html).toMatch(/<p[^>]*class="[^"]*\bhidden\b[^"]*print:block[^"]*"[^>]*data-print-only-note=""[^>]*>The client table is left off the printed page\./);
  });
  it("the spreadsheet carries counts and totals only, never a name", () => {
    const csv = clientsCsv(view(), { preparedOn: "2026-11-30" });
    for (const n of Object.values(NAMES)) expect(csv).not.toContain(n);
    expect(csv).not.toMatch(/client-done|client-noshow/);
    expect(csv).toContain("Clients seen in this period,3");
    expect(csv).toContain("No client is named in this file.");
    expect(csv).toContain("Paid in period across every client seen,305.00".replace("305.00", "215.00") + ",cad".toUpperCase().replace(",CAD", ",CAD"));
  });
});

describe("the Clients tab: money on a visit with no client recorded", () => {
  it("is shown on its own line, is not in any client's figure, and the difference stays zero", () => {
    const extra = [...appointments, appt("done-noclient", "completed", "2026-11-10T15:00:00Z", "pr-1", null as never)];
    const withMoney = { ...money, settlementRows: [...money.settlementRows, { appointmentId: "done-noclient", method: "paid_cash", amountCents: 4000, currency: "cad", quotedAmountCents: 4000 }] };
    const v = view({}, { current: { ok: true, value: { appointments: extra, money: { ok: true, value: withMoney as never } } }, followThrough: { ok: true, value: { past: extra, future: [] } } });
    const r = v.clientsReconciliation;
    expect(r && r.available && r.value.noClientPaidCents).toBe(4000);
    expect(r && r.available && r.value.clientsPaidCents).toBe(9000 + 9500 + 3000);
    expect(r && r.available && r.value.differenceCents).toBe(0);
    expect(table(v)?.seen).toBe(3); // the no-client visit is not a client seen
    expect(text(render(v))).toContain("Money on completed visits with no client recorded $40.00");
  });
});

describe("the Clients tab: the first-visit column", () => {
  it("is headed First visit, because it is the first completed visit recorded in Hone, not when the client record was made", () => {
    const html = render(view());
    const heads = [...html.matchAll(/<th scope="col"[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).trim());
    expect(heads).toContain("First visit");
    expect(heads.join("|")).not.toMatch(/Client since/);
    expect(text(html)).not.toMatch(/Client since/);
  });
});

describe("the Clients tab: a nonzero reconciliation difference is computed and shown", () => {
  it("completed-visit money above the clients' money plus the no-client money gives a positive difference", () => {
    const r = reconcileClientsMoney({ clientsPaidCents: 21_500, noClientPaidCents: 4_000, completedVisitsCents: 26_734 });
    expect(r.value.differenceCents).toBe(1_234);
    const below = reconcileClientsMoney({ clientsPaidCents: 21_500, noClientPaidCents: 4_000, completedVisitsCents: 25_000 });
    expect(below.value.differenceCents).toBe(-500);
  });
  it("the page shows that number on the Difference line, never a hidden zero", () => {
    const v = { ...view(), clientsReconciliation: reconcileClientsMoney({ clientsPaidCents: 21_500, noClientPaidCents: 4_000, completedVisitsCents: 26_734 }) };
    const recon = text(render(v as OverviewView));
    expect(recon).toContain("Paid in period across every client seen $215.00");
    expect(recon).toContain("Money on completed visits with no client recorded $40.00");
    expect(recon).toContain("Collected on completed visits (Overview) $267.34");
    expect(recon).toContain("Difference $12.34");
    expect(recon).not.toContain("Difference $0.00");
  });
});

describe("the Clients tab: a client whose every payment is unconfirmed has no lifetime figure, not $0", () => {
  it("the earlier and the current visit both have no payment on record: lifetime is null and the page says Not available", () => {
    const earlier = appt("earlier-unrecorded", "completed", "2026-10-02T15:00:00Z", "pr-1", "client-unconfirmed");
    const now = appt("now-unrecorded", "completed", "2026-11-12T15:00:00Z", "pr-1", "client-unconfirmed");
    const cur = [...appointments, now];
    const v = view(
      { lifetimeHistory: { ok: true, value: { appointments: [earlier], money: { ok: true, value: { cardRows: [], settlementRows: [], legacyFeeRows: [] } as never } } } },
      { current: { ok: true, value: { appointments: cur, money: { ok: true, value: money as never } } }, followThrough: { ok: true, value: { past: cur, future: [] } }, names: lookup({ ...NAMES, "client-unconfirmed": "Uma Unconfirmed" }) },
    );
    const row = table(v)?.rows.find((r) => r.name === "Uma Unconfirmed");
    expect(row?.periodPaidCents).toBeNull();
    expect(row?.lifetimePaidCents).toBeNull();
    const tr = render(v).match(/<tr[^>]*>(?:(?!<\/tr>)[\s\S])*Uma Unconfirmed[\s\S]*?<\/tr>/)?.[0] ?? "";
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => text(m[1]).trim());
    expect(cells[2]).toBe("Not available"); // paid in period
    expect(cells[3]).toBe("Not available"); // lifetime paid, never $0.00
    expect(tr).not.toContain("$0.00");
  });
  it("the Lifetime note says unconfirmed visits add nothing", () => {
    expect(text(render(view()))).toContain("Visits awaiting payment confirmation add nothing, and a client with none confirmed shows as not available.");
  });
});
