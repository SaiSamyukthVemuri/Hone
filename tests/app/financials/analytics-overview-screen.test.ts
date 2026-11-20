import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OverviewScreen } from "@/app/(app)/financials/analytics/overview-screen";
import { FIGURE_UNAVAILABLE_COPY, type ReadFailure } from "@/lib/business-analytics/figure";
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
const render = (view: OverviewView, over: Partial<Parameters<typeof OverviewScreen>[0]> = {}) =>
  renderToStaticMarkup(createElement(OverviewScreen, { view, params, notices: [], practitionerOptions: [{ id: "pr-1", label: "Ada Example" }], format: fmt, ...over }));
const healthy = () => buildOverview(input());

const CARD_OF = {
  collected: "ov-collected-total",
  series: "ov-series",
  byPractitioner: "ov-bypractitioner",
  serviceValue: "ov-servicevalue",
  reconciliation: "ov-line",
  completedVisits: "ov-visits",
  activeClients: "ov-clients",
  visitsPerClient: "ov-vpc",
  averagePaid: "ov-avgpaid",
  returning: "ov-returning",
  interval: "ov-interval",
  noNextBooking: "ov-nonext",
} as const;
const card = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-figure="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? null;
/** React writes an apostrophe as an entity, so the expected sentence is escaped the same way. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const REASONS: ReadFailure[] = ["too_many_appointments", "read_failed", "currency_unknown", "not_reconciled", "no_evidence_read"];

describe("the Overview screen renders the view it is given", () => {
  const html = render(healthy());
  it("shows the collected total with its lines, and the line from service value to collected", () => {
    const c = card(html, "ov-collected-total") ?? "";
    expect(c).toContain("$265.00"); // 9000 + 9500 + 3000 + 5000
    expect(c).toContain("$215.00"); // on completed visits
    expect(c).toContain("$50.00"); // fees
    const line = card(html, "ov-line") ?? "";
    expect(line).toContain("= Collected");
    expect(line).toContain("$180.00"); // completed service value: 9000 + 9000
  });
  it("says what each figure is called and never calls collected revenue", () => {
    expect(html).toContain("Collected (by visit date)");
    expect(html).toContain("Completed service value (by visit date)");
    expect(html).not.toMatch(/revenue|by payment date/i);
  });
  it("the unread online-booking class is shown as not available, never as zero", () => {
    const sv = card(html, "ov-servicevalue") ?? "";
    expect(sv).toContain("Price shown at online booking:");
    expect(sv).toMatch(/Price shown at online booking:<\/span> Not available\./);
  });
  it("the owner-only note is on the page and in the definitions", () => {
    expect(html.match(/Only the studio owner is shown this page/g)?.length).toBe(2);
  });
});

describe("every unavailable figure renders its reason sentence, never a blank, a zero or a dropped card", () => {
  it("every card on the page has a case here, so a new card without a test fails first", () => {
    const ids = [...render(healthy()).matchAll(/data-figure="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(Object.values(CARD_OF).sort());
  });
  for (const [key, id] of Object.entries(CARD_OF)) {
    for (const reason of REASONS) {
      it(`${key} unavailable (${reason}) shows "${FIGURE_UNAVAILABLE_COPY[reason].slice(0, 28)}…"`, () => {
        const view = { ...healthy(), [key]: { available: false, reason } } as OverviewView;
        const c = card(render(view), id);
        expect(c, "the card must still be there").not.toBeNull();
        expect(c).toContain(esc(FIGURE_UNAVAILABLE_COPY[reason]));
        expect(c).not.toMatch(/\$\s?\d|>\s*0\s*</); // no amount and no bare 0 inside an unavailable card
        expect(c).not.toContain("<svg");
      });
    }
  }
  it("the whole view unavailable still shows every card, each with its sentence", () => {
    const gone = Object.fromEntries(Object.keys(CARD_OF).map((k) => [k, { available: false, reason: "read_failed" }]));
    const html = render({ ...healthy(), ...gone } as OverviewView);
    for (const id of Object.values(CARD_OF)) expect(card(html, id) ?? "", id).toContain(esc(FIGURE_UNAVAILABLE_COPY.read_failed));
  });
});

describe("charts are server-rendered with their data in a table", () => {
  const html = render(healthy());
  it("has SVG with a title and description, no script, and the same rows in a table", () => {
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script");
    const series = card(html, "ov-series") ?? "";
    expect(series).toMatch(/<title id="ov-series-chart-title">Collected by visit date<\/title>/);
    expect((series.match(/<rect /g) ?? []).length).toBe(30);
    expect((series.match(/<tr class="border-b border-line\/60"/g) ?? []).length).toBe(30);
  });
  it("team chart keys are opaque, labels are display names, a former member is not named", () => {
    const team = card(html, "ov-bypractitioner") ?? "";
    expect(team).toContain("Ada Example");
    expect(team).toContain("Former team member");
    expect(team).not.toContain("Grace");
    expect(team).not.toMatch(/data-key|pr-1|pr-2/);
  });
  it("the chart toggle keeps the other choices", () => {
    expect(html).toContain('href="/financials/analytics?period=custom&amp;from=2026-11-01&amp;to=2026-11-30&amp;series=visits"');
  });
});

describe("what the page may and may not carry", () => {
  it("no appointment id, client id or practitioner id appears anywhere except the filter's own option value", () => {
    const html = render(healthy(), { practitionerOptions: [{ id: "pr-1", label: "Ada Example" }] });
    const withoutOptions = html.replace(/<option[^>]*>[^<]*<\/option>/g, "");
    for (const id of [...appointments.map((a) => a.id), ...appointments.map((a) => a.clientId), "pr-1", "pr-2"]) expect(withoutOptions, id).not.toContain(id);
  });
  it("no next booking stays a count: no client list, no client id and no link to clients on the page", () => {
    const html = render(healthy());
    const c = card(html, "ov-nonext") ?? "";
    expect(c).toMatch(/<p class="[^"]*">\d+<\/p>/);
    expect(c).not.toMatch(/<a |<li|href=/);
    expect(html).not.toMatch(/client-[a-z]/);
    expect(html).not.toMatch(/href="[^"]*client/i);
  });
  it("a bad value on the page shows its notice sentence", () => {
    expect(render(healthy(), { notices: ["The period in the address was not recognised, so the default is shown."] })).toContain("The period in the address was not recognised");
  });
});

describe("the interval card under a team-member filter", () => {
  // Ada's earlier visits were with pr-1; in November she is seen by pr-2 only.
  const earlier = [appt("e1", "completed", "2026-10-10T15:00:00Z", "pr-1", "client-ada"), appt("e2", "completed", "2026-10-20T15:00:00Z", "pr-1", "client-ada")];
  const nov = [appt("n1", "completed", "2026-11-05T15:00:00Z", "pr-2", "client-ada")];
  const empty = { cardRows: [], settlementRows: [], legacyFeeRows: [] };
  const view = (filter: OverviewInput["filter"]) => buildOverview(input({ filter, current: { ok: true, value: { appointments: nov, money: { ok: true, value: empty as never } } }, history: { ok: true, value: { appointments: earlier } } }));
  const text = (html: string, id: string) => (card(html, id) ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  it("studio-wide, her gaps count; under the filter her earlier visits are not that team member's, so she is left out and counted, while the returning card still counts any practitioner", () => {
    const all = render(view({ kind: "all" }));
    expect(text(all, "ov-interval")).toMatch(/1 client has two or more visits; 0 have fewer/);
    const one = render(view({ kind: "one", practitionerId: "pr-2" }));
    expect(text(one, "ov-interval")).toMatch(/0 clients have two or more visits; 1 has fewer and is left out/);
    expect(text(one, "ov-interval")).toContain("With a team-member filter, only that team member's visits are used.");
    expect(text(one, "ov-returning")).toMatch(/1 returning, 0 first-time/);
  });
});

describe("the chart's left margin follows its longest axis label", () => {
  it("a long money label is never cut off, and short ones keep the minimum margin", async () => {
    const { tickMargin } = await import("@/app/(app)/financials/analytics/charts");
    const long = "$1,000.00 CAD";
    expect(tickMargin([long, "$0.00 CAD"])).toBeGreaterThanOrEqual(Math.ceil(long.length * 6.6));
    expect(tickMargin(["$5", "0"])).toBe(64);
    expect(tickMargin([])).toBe(64);
  });
});
