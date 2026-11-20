import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OverviewScreen } from "@/app/(app)/financials/analytics/overview-screen";
import { FIGURE_UNAVAILABLE_COPY, type ReadFailure } from "@/lib/business-analytics/figure";
import { formatExact } from "@/lib/business-analytics/money-format";
import { DEFAULT_BEYOND_USUAL_FACTOR } from "@/lib/business-analytics/visit-metrics";
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

/** Every card on the page, with the view key that feeds it. A key may feed more than one card. */
const CARDS: ReadonlyArray<readonly [string, string]> = [
  ["collected", "ov-collected-total"],
  ["completedVisits", "ov-visits"],
  ["averagePaid", "ov-avgpaid"],
  ["activeClients", "ov-clients"],
  ["series", "ov-series"],
  ["returning", "ov-returning"],
  ["interval", "ov-interval"],
  ["collected", "ov-month-collected"],
  ["returning", "ov-month-new"],
  ["visitsPerClient", "ov-vpc"],
  ["visitFrequency", "ov-frequency"],
  ["byPractitioner", "ov-bypractitioner"],
  ["noNextBooking", "ov-nonext"],
  ["beyondUsual", "ov-beyond"],
  ["collected", "ov-split"],
  ["serviceValue", "ov-servicevalue"],
  ["reconciliation", "ov-line"],
  ["namedClients", "ov-top-spenders"],
  ["namedClients", "ov-most-visits"],
  ["namedClients", "ov-frequent-returns"],
];
const NAMED_IDS = ["ov-top-spenders", "ov-most-visits", "ov-frequent-returns"];
const CARD_IDS = CARDS.map(([, id]) => id).sort();
const card = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-figure="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? null;
/** React writes an apostrophe as an entity, so the expected sentence is escaped the same way. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const REASONS: ReadFailure[] = ["too_many_appointments", "read_failed", "currency_unknown", "not_reconciled", "no_evidence_read"];

describe("the Overview screen renders the view it is given", () => {
  const html = render(healthy());
  it("shows the collected total with its lines, and the line from service value to collected", () => {
    expect(card(html, "ov-collected-total") ?? "").toContain("$265"); // 9000 + 9500 + 3000 + 5000, whole dollars on the card
    expect(card(html, "ov-collected-total") ?? "").not.toContain("$265.00"); // the exact cents are in the split, not on the card
    const split = card(html, "ov-split") ?? "";
    expect(split).toContain("$215.00"); // on completed visits
    expect(split).toContain("$50.00"); // fees
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
    expect(html.match(/Only the studio owner is shown this page/g)?.length).toBe(2); // the definitions and the footer
  });
});

describe("every unavailable figure renders its reason sentence, never a blank, a zero or a dropped card", () => {
  it("every card on the page has a case here, so a new card without a test fails first", () => {
    const ids = [...render(healthy()).matchAll(/data-figure="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(CARD_IDS);
  });
  for (const [key, id] of CARDS) {
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
    const gone = Object.fromEntries([...new Set(CARDS.map(([k]) => k))].map((k) => [k, { available: false, reason: "read_failed" }]));
    const html = render({ ...healthy(), ...gone } as OverviewView);
    for (const id of CARD_IDS) expect(card(html, id) ?? "", id).toContain(esc(FIGURE_UNAVAILABLE_COPY.read_failed));
  });
});

describe("charts are server-rendered with their data in a table", () => {
  const html = render(healthy());
  it("has SVG with a title and description, no script, and the same rows in a table", () => {
    expect(html).toContain("<svg");
    expect(html).not.toContain("<script");
    const series = card(html, "ov-series") ?? "";
    expect(series).toMatch(/<title id="ov-series-chart-title">Collected by visit date<\/title>/);
    expect((series.match(/<path (?![^>]*data-area)/g) ?? []).length).toBe(1); // the previous period could not be read: one line, not an empty second one
    expect(series).not.toContain("<rect ");
    expect((series.match(/<tr class="border-b border-line\/60"/g) ?? []).length).toBe(30);
  });
  it("team chart keys are opaque, labels are display names, a former member is not named", () => {
    const team = card(html, "ov-bypractitioner") ?? "";
    expect(team).toContain("Ada Example");
    expect(team).toContain("Former team member");
    expect(team).not.toContain("Grace");
    expect(team).not.toMatch(/data-key|pr-1|pr-2/);
    expect(team).toContain("$"); // each row carries its amount as text, not only as a bar
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

describe("downloads and print", () => {
  it("the screen links to the CSV and the print page with the same choices", () => {
    const html = render(healthy());
    expect(html).toContain('href="/financials/analytics/export.csv?period=custom&amp;from=2026-11-01&amp;to=2026-11-30"');
    expect(html).toContain('href="/financials/analytics/print?period=custom&amp;from=2026-11-01&amp;to=2026-11-30"');
  });
  it("the printable form drops the controls, the toggle and the download links, and keeps every card", () => {
    const html = render(healthy(), { print: true });
    expect(html).not.toContain("<form");
    expect(html).not.toContain("export.csv");
    expect(html).toContain("data-print-footer");
    const ids = [...html.matchAll(/data-figure="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(ids).toEqual(CARD_IDS.filter((id) => !NAMED_IDS.includes(id))); // the named lists are not printed
    expect(html).toContain("Client names are left off the printed page.");
    expect(html).not.toContain("aria-label=\"Analytics sections\"");
    expect(html).not.toContain("Export data");
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
    expect(text(one, "ov-returning")).toMatch(/1 returning\s+0 first-time/);
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


describe("the filter in force is always stated (U1)", () => {
  const showing = (html: string) => (html.match(/data-showing="">([^<]*)</)?.[1] ?? "").replace(/&#x27;/g, "'");
  const withFilter = (practitioner: OverviewParams["practitioner"]) => render(healthy(), { params: { ...params, practitioner } });
  it("says Everyone, the member's name, Former team member for one not in the list, or Unattributed", () => {
    expect(showing(withFilter({ kind: "all" }))).toBe("Showing: Everyone");
    expect(showing(withFilter({ kind: "one", practitionerId: "pr-1" }))).toBe("Showing: Ada Example");
    expect(showing(withFilter({ kind: "one", practitionerId: "pr-2" }))).toBe("Showing: Former team member");
    expect(showing(withFilter({ kind: "unattributed" }))).toBe("Showing: Unattributed");
  });
  it("the by-team-member card says it stays whole-studio under a filter", () => {
    const html = withFilter({ kind: "one", practitionerId: "pr-1" });
    expect(card(html, "ov-bypractitioner") ?? "").toContain("always shows the whole studio, whatever team member is chosen above");
  });
});

describe("an unknown figure is never drawn as a zero (U3)", () => {
  const unknownReturning = { available: true, value: { activeClients: 0, returning: 0, firstTime: 0, returningPercent: { known: false, reason: "No client had a completed visit in this period." } } } as unknown as OverviewView["returning"];
  const text = (html: string, id: string) => (card(html, id) ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  it("an unknown returning percent shows its reason, not 0%", () => {
    const t = text(render({ ...healthy(), returning: unknownReturning }), "ov-returning");
    expect(t).toContain("No client had a completed visit in this period.");
    expect(t).not.toMatch(/\b0\s*%/);
  });
  it("an unknown visits-per-client or average-paid fact shows its reason, not 0.0 or $0.00", () => {
    const vpc = { available: true, value: { known: false, reason: "No client was seen." } } as unknown as OverviewView["visitsPerClient"];
    const avg = { available: true, value: { averageCents: { known: false, reason: "No visit has a known payment." }, excludedUnknownVisits: 0 } } as unknown as OverviewView["averagePaid"];
    const html = render({ ...healthy(), visitsPerClient: vpc, averagePaid: avg });
    expect(text(html, "ov-vpc")).toContain("No client was seen.");
    expect(text(html, "ov-vpc")).not.toMatch(/0\.0/);
    expect(text(html, "ov-avgpaid")).toContain("No visit has a known payment.");
    expect(text(html, "ov-avgpaid")).not.toContain("$0.00");
  });
  it("an unavailable comparison says so, not +0.0%", () => {
    const base = healthy();
    const collected = base.collected.available ? { ...base.collected, value: { ...base.collected.value, change: { kind: "unavailable" } } } : base.collected;
    const visits = base.completedVisits.available ? { ...base.completedVisits, value: { ...base.completedVisits.value, change: { kind: "unavailable" } } } : base.completedVisits;
    const html = render({ ...base, collected, completedVisits: visits } as OverviewView);
    expect(text(html, "ov-collected-total")).toContain("The comparison is not available.");
    expect(text(html, "ov-visits")).toContain("The comparison is not available.");
    expect(html).not.toMatch(/[+−]0\.0%/);
  });
});

describe("the collected figure states its basis (U4), beside the cards", () => {
  it("carries the money basis note and the Statements sentence on the page, outside the cards so the four stay level", async () => {
    const { MONEY_BASIS_NOTE } = await import("@/lib/business-analytics/money-metrics");
    const html = render(healthy()).replace(/&#x27;/g, "'");
    const note = html.match(/<p[^>]*data-collected-basis=""[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? "";
    expect(note).toContain(MONEY_BASIS_NOTE);
    expect(note).toMatch(/Statements/);
    expect(card(html, "ov-collected-total") ?? "").not.toContain(MONEY_BASIS_NOTE);
  });
});


describe("a period with no visits at all draws no false zero (U3, through the real model)", () => {
  it("returning, visits per client, average paid and the comparisons say why instead of 0", () => {
    const empty = { cardRows: [], settlementRows: [], legacyFeeRows: [] };
    const view = buildOverview(input({ current: { ok: true, value: { appointments: [], money: { ok: true, value: empty as never } } }, history: { ok: true, value: { appointments: [] } } }));
    const t = (id: string) => (card(render(view), id) ?? "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
    expect(t("ov-returning")).not.toMatch(/\b0\s*%/);
    expect(t("ov-vpc")).not.toMatch(/\b0\.0\b/);
    expect(t("ov-avgpaid")).not.toContain("$0.00");
  });
});

describe("the Overview layout", () => {
  const html = render(healthy());
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  it("has the new title, the Overview tab as current, and the other four as disabled text: no link, no route", () => {
    expect(html).toContain("<h1");
    expect(text(html)).toContain("Your practice, in perspective.");
    const tabs = html.match(/<ul[^>]*aria-label="Analytics sections"[^>]*>([\s\S]*?)<\/ul>/)?.[1] ?? "";
    expect(tabs).toContain('aria-current="page"');
    expect((tabs.match(/aria-disabled="true"/g) ?? []).length).toBe(4);
    expect(tabs).not.toMatch(/<a |href=/);
    expect(text(tabs)).toMatch(/Clients.*not available yet.*Capacity.*not available yet.*Treatments.*not available yet.*Team.*not available yet/);
  });
  it("Export data and Print / Save PDF are the existing routes; no explore links to unbuilt pages", () => {
    expect(html).toMatch(/<a href="\/financials\/analytics\/export\.csv[^"]*"[^>]*>Export data<\/a>/);
    expect(html).toMatch(/<a href="\/financials\/analytics\/print[^"]*"[^>]*>Print \/ Save PDF<\/a>/);
    expect(html).not.toMatch(/Explore client history|View all clients|Explore completed visits/);
  });
  it("the line chart draws two lines (current solid, previous dashed) when the previous period is readable, with the chart data closed on screen and open in print", () => {
    const withPrev = buildOverview(input({ comparison: { ok: true, value: { appointments: [appt("p1", "completed", "2026-10-05T15:00:00Z", "pr-1", "client-x")], money: { ok: true, value: { cardRows: [], settlementRows: [], legacyFeeRows: [] } as never } } } }));
    const screen = card(render(withPrev), "ov-series") ?? "";
    expect((screen.match(/<path (?![^>]*data-area)/g) ?? []).length).toBe(2);
    expect(screen).toContain('stroke-dasharray="5 3"');
    expect(screen).toMatch(/<details class="text-sm" data-chart-data="">/);
    expect(card(render(withPrev, { print: true }), "ov-series") ?? "").toMatch(/<details open="" class="text-sm" data-chart-data="">/);
    expect(screen).toContain("View chart data");
  });
  it("a previous period that could not be read is said, not drawn as a flat or zero line", () => {
    const series = card(html, "ov-series") ?? "";
    expect(series).toContain("The previous period is not drawn.");
    expect(series).not.toContain('stroke-dasharray="5 3"><');
  });
  it("is neutral: no sage or other decorative green in the page's markup", () => {
    expect(html).not.toMatch(/#6f8a64|#d6dbd3|#edf1eb|sage/i);
  });
  it("follow-through shows the beyond-usual count and says Charts with unfinished sections is not available yet, never a number", () => {
    const f = text(html);
    expect(card(html, "ov-beyond")).not.toBeNull();
    expect(f).toContain("Charts with unfinished sections");
    expect(f).toContain("permissions design");
    expect(html).toMatch(/data-unavailable-section="ov-unfinished"/);
  });
  it("the reconciliation sits in a closed disclosure on screen and an open one in print", () => {
    expect(html).toMatch(/<details class="[^"]*" data-reconciliation="">/);
    expect(render(healthy(), { print: true })).toMatch(/<details open="" class="[^"]*" data-reconciliation="">/);
  });
  it("the footer carries the currency and the studio's time zone", () => {
    expect(text(html)).toContain("CAD");
    expect(text(html)).toContain("America/Toronto");
  });
  it("an average-paid change appears only when the average is known", () => {
    const view = { ...healthy(), averagePaid: { available: true, value: { averageCents: { known: false, reason: "No completed visit." }, excludedUnknownVisits: 0 } } } as unknown as OverviewView;
    expect(text(card(render(view), "ov-avgpaid") ?? "")).not.toMatch(/compared with/);
  });
});

describe("chart markers, the money difference, month wording and the beyond-usual scope note", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const oneDay = (): OverviewView => {
    const view = healthy();
    const series = { available: true, value: { unit: "day", points: [{ key: "2026-11-01", collectedCents: 9000, completedVisits: 1 }] } };
    return { ...view, series, previousSeries: series } as unknown as OverviewView;
  };
  it("a one-point series draws a visible marker (a circle), and its row is still in the data table", () => {
    const c = card(render(oneDay()), "ov-series") ?? "";
    expect((c.match(/<circle[^>]*data-isolated="current"/g) ?? []).length).toBe(1);
    expect((c.match(/<circle[^>]*data-isolated="previous"/g) ?? []).length).toBe(1);
    expect((c.match(/<tr class="border-b border-line\/60"/g) ?? []).length).toBe(1);
    expect(c).toContain("$90.00");
  });
  it("a multi-point series has no isolated marker, because its stroke is visible", () => {
    expect(card(render(healthy()), "ov-series") ?? "").not.toContain("data-isolated");
  });
  it("the screen says the difference from the model's direction, and says nothing when the model has none", () => {
    const v = healthy();
    const c = (d: unknown) => text(card(render({ ...v, collected: { available: true, value: { ...(v.collected as { value: object }).value, difference: d } } } as unknown as OverviewView), "ov-month-collected") ?? "");
    expect(c({ direction: "more", cents: 24800 })).toContain("$248.00 more collected");
    expect(c({ direction: "less", cents: 4000 })).toContain("$40.00 less collected");
    expect(c({ direction: "same", cents: 0 })).toContain("No change in collected");
    expect(c(null)).toContain("The comparison is not available.");
  });
  it("a month-unit series speaks of months, not days", () => {
    const view = healthy();
    const months = (n: number) => ({ available: true, value: { unit: "month", points: Array.from({ length: n }, (_, i) => ({ key: `2026-0${i + 1}`, collectedCents: 100, completedVisits: 1 })) } });
    const c = text(card(render({ ...view, series: months(3), previousSeries: months(2) } as unknown as OverviewView), "ov-series") ?? "");
    expect(c).toContain("same month number");
    expect(c).toContain("That period has 2 months, so its line ends sooner.");
    expect(c).not.toMatch(/same day number|That period has \d+ days/);
  });
  it("population note: under a team-member filter the beyond-usual card says it counts every client that team member has ever seen", () => {
    const view = healthy();
    expect(text(card(render({ ...view, filterKind: "one" } as OverviewView), "ov-beyond") ?? "")).toContain("every client that team member has ever seen, not only those seen in this period");
    expect(text(card(render(view), "ov-beyond") ?? "")).not.toContain("ever seen");
    expect(text(render(view))).toContain("every client that team member has ever seen"); // the definitions always say it
  });
  it("the factor on the page is the one the model uses", () => {
    expect(text(card(render(healthy()), "ov-beyond") ?? "")).toContain(`than ${DEFAULT_BEYOND_USUAL_FACTOR} times`);
  });
});

describe("period line, axis labels and chart-data row labels", () => {
  it("the period line is said once, not again in the notes", () => {
    const html = render(healthy());
    const line = `${healthy().currentLabel} compared with ${healthy().comparisonLabel}.`;
    expect(html.split(line.replace(/&/g, "&amp;")).length - 1).toBe(1 + 0);
  });
  it("the last axis label is not drawn on top of the one before it", () => {
    const labels = (html: string) => [...(card(html, "ov-series") ?? "").matchAll(/<text[^>]*text-anchor="(?:start|middle|end)"[^>]*font-size="11"[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).filter((t) => /\d+ [A-Z][a-z]{2}/.test(t));
    const l = labels(render(healthy()));
    expect(l.at(-1)).toBe("30 Nov");
    expect(l.at(-2)).not.toBe("29 Nov"); // the label before the last is far enough from it
  });
});

describe("compact controls, whole-dollar headline figures and the area under the line", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  it("compact controls: a period list, a practitioner list and a Show button, with the dates and the comparison in a group a custom period reveals", () => {
    const form = render(healthy()).match(/<form[^>]*aria-label="Period and team member"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(form).toMatch(/<select[^>]*name="period"/);
    expect(form).toMatch(/<select[^>]*name="practitioner"/);
    expect(form).toMatch(/<button type="submit"[^>]*>Show<\/button>/);
    const custom = form.match(/<div[^>]*data-custom-range=""[\s\S]*?<\/div>/)?.[0] ?? "";
    expect(custom).toMatch(/name="from"/);
    expect(custom).toMatch(/name="to"/);
    expect(custom).toMatch(/name="compare"/);
    expect(form).toContain("group-has-[option[value=custom]:checked]:flex"); // hidden until Custom is chosen, with no script
    expect(form).toContain("All practitioners");
    for (const k of ["month_to_date", "previous_month", "year_to_date", "custom"]) expect(form).toContain(`value="${k}"`);
  });
  it("the form submits exactly the names the strict parser reads, by GET to the same path", () => {
    const form = render(healthy(), { practitionerOptions: [{ id: "pr-1", label: "Ada Example" }] }).match(/<form[\s\S]*?<\/form>/)?.[0] ?? "";
    expect([...form.matchAll(/name="([a-z]+)"/g)].map((m) => m[1]).sort()).toEqual(["compare", "from", "period", "practitioner", "to"]);
    expect(form).toContain('action="/financials/analytics"');
    expect(form).toContain('method="get"');
  });
  it("headline cards show whole dollars with one currency word; exact cents stay in the split and the chart data", () => {
    const html = render(healthy());
    expect(text(card(html, "ov-collected-total") ?? "")).toMatch(/\$265 CAD/);
    expect(card(html, "ov-split") ?? "").toContain("$265.00");
    expect(card(html, "ov-series") ?? "").toContain("$90.00");
  });
  it("rounding is display only: the model's exact cents are unchanged, the split still adds up to them, and the card is within 50 cents", () => {
    const view = healthy();
    const c = (view.collected as { value: { headlineCents: number; split: { totalCents: number } } }).value;
    expect(c.headlineCents).toBe(26500);
    expect(c.split.totalCents).toBe(c.headlineCents);
    const shown = Number((text(card(render(view), "ov-collected-total") ?? "").match(/\$([\d,]+)/) ?? [])[1].split(",").join(""));
    expect(Math.abs(shown * 100 - c.headlineCents)).toBeLessThanOrEqual(50);
    // a figure that is not a whole dollar rounds on the card but is unchanged in the view
    const odd = { ...view, collected: { available: true, value: { ...(view.collected as { value: object }).value, headlineCents: 26549 } } } as unknown as OverviewView;
    expect(text(card(render(odd), "ov-collected-total") ?? "")).toMatch(/\$265 CAD/);
    expect((odd.collected as { value: { headlineCents: number } }).value.headlineCents).toBe(26549);
  });
  it("the reconciliation's total and the average paid keep exact cents, while the other headline cards are whole dollars", () => {
    const v = healthy();
    const exact = (view: OverviewView) => render(view, { format: formatExact });
    const line = { serviceValueCents: 146165, collectedAbovePriceCents: 0, collectedBelowPriceCents: 0, collectedOnNoEvidenceCents: 0, feesCents: 5, uncompletedPaymentsCents: 0, otherBookingsCents: 0, collectedCents: 146170 };
    const view = {
      ...v,
      reconciliation: { available: true, value: line },
      averagePaid: { available: true, value: { averageCents: { known: true, value: 8742 }, excludedUnknownVisits: 0 } },
      collected: { available: true, value: { ...(v.collected as { value: object }).value, headlineCents: 146170 } },
    } as unknown as OverviewView;
    const html = exact(view);
    expect(text(card(html, "ov-line") ?? "")).toMatch(/= Collected \$1,461\.70/);
    expect(text(card(html, "ov-avgpaid") ?? "")).toContain("$87.42");
    expect(text(card(html, "ov-collected-total") ?? "")).toMatch(/\$1,462 CAD/);
  });
  it("the beyond-usual count is shown apart from the clients not judged", () => {
    const view = { ...healthy(), beyondUsual: { available: true, value: { count: 3, notEnoughHistory: 2 } } } as unknown as OverviewView;
    const c = text(card(render(view), "ov-beyond") ?? "");
    expect(c).toMatch(/^\s*Beyond their usual visit interval 3 /);
    expect(c).toContain("2 clients have fewer than two visit dates");
  });
  it("a comparison period's extra days, which nothing draws, do not stretch the axis", () => {
    const view = healthy();
    const day = (n: number, cents: number) => ({ key: `2026-02-${String(n).padStart(2, "0")}`, collectedCents: cents, completedVisits: 1 });
    const current = { available: true, value: { unit: "day", points: Array.from({ length: 28 }, (_, i) => day(i + 1, 10000)) } };
    // January has 31 days: the last three carry a huge amount that the 28-day chart never shows.
    const previous = { available: true, value: { unit: "day", points: Array.from({ length: 31 }, (_, i) => ({ key: `2026-01-${String(i + 1).padStart(2, "0")}`, collectedCents: i >= 28 ? 5_000_000 : 10000, completedVisits: 1 })) } };
    const c = card(render({ ...view, series: current, previousSeries: previous } as unknown as OverviewView), "ov-series") ?? "";
    const ticks = [...c.matchAll(/<text[^>]*text-anchor="end"[^>]*font-size="11"[^>]*>(\$[\d,.]+)<\/text>/g)].map((m) => m[1]);
    expect(ticks.length).toBeGreaterThan(1);
    const top = Number((ticks.at(-1) ?? "").split("$").join("").split(",").join(""));
    expect(top).toBeGreaterThanOrEqual(100); // every drawn day is $100
    expect(top).toBeLessThanOrEqual(200); // and the axis stops near it, not near the $50,000 days that are cut off
    expect(c).not.toContain("50,000"); // the cut-off amounts are not in the table either
  });
  it("the current line has a faint neutral area under it", () => {
    const c = card(render(healthy()), "ov-series") ?? "";
    expect((c.match(/data-area="current"/g) ?? []).length).toBe(1);
    expect(c).toMatch(/data-area="current"[^>]*fill-opacity="0\.06"/);
  });
});

describe("the named client lists on the page", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const named = (names: Record<string, string>) => buildOverview(input({ names: { ok: true, names: new Map(Object.entries(names)) } }));
  const NAMES = { "client-done-quoted": "Quinn Quoted", "client-done-over": "Olive Over", "client-done-noprice": "Nia Noprice", "client-noshow": "Nora Noshow" };
  const section = (html: string) => html.match(/<section[^>]*data-named-clients=""[\s\S]*?<\/section>\s*<section aria-labelledby="ov-review"/)?.[0] ?? "";
  it("shows the three lists with display names, in order, and the cap sentence", () => {
    const html = render(named(NAMES));
    const s = section(html);
    expect(s).toContain("Your client relationships");
    const spend = card(html, "ov-top-spenders") ?? "";
    expect(spend.indexOf("Olive Over")).toBeGreaterThan(-1);
    expect(spend.indexOf("Olive Over")).toBeLessThan(spend.indexOf("Quinn Quoted")); // $95.00 before $90.00
    expect(spend.indexOf("Quinn Quoted")).toBeLessThan(spend.indexOf("Nia Noprice"));
    expect(text(s)).toContain("All 3 clients seen in this period.");
    expect(s).not.toContain("Nora Noshow"); // no completed visit
  });
  it("names the highest spend once, with exact cents, in the period review", () => {
    const html = render(named(NAMES));
    const c = text(card(html, "ov-highest-spend") ?? "");
    expect(c).toContain("Olive Over");
    expect(c).toContain("$95.00");
  });
  it("lists carry no link and no client id anywhere in the markup or the view", () => {
    const view = named(NAMES);
    const html = render(view);
    const s = section(html) + (card(html, "ov-highest-spend") ?? "");
    expect(s).not.toMatch(/<a |href=/);
    expect(html).not.toMatch(/client-done|client-noshow|client-old/);
    expect(JSON.stringify(view)).not.toMatch(/client-done|client-noshow|client-old/);
  });
  it("a client who cannot be named is counted in the totals and mentioned once, never listed or called Unknown", () => {
    const withAll = named(NAMES);
    const without = named({ "client-done-quoted": "Quinn Quoted" });
    expect(without.activeClients).toEqual(withAll.activeClients);
    expect(without.collected).toEqual(withAll.collected);
    const html = render(without);
    expect(text(section(html))).toContain("2 clients seen in this period are not listed because they are archived or have no name on record.");
    expect(html).not.toMatch(/Unknown/);
  });
  it("when the names cannot be read, each list says so and the rest of the page is unchanged", () => {
    const view = buildOverview(input({ names: { ok: false } }));
    const html = render(view);
    for (const id of NAMED_IDS) expect(card(html, id) ?? "").toContain(esc(FIGURE_UNAVAILABLE_COPY.read_failed));
    expect(view.collected).toEqual(named(NAMES).collected);
  });
  it("when money is unavailable the spenders list says so and the visit lists still show", () => {
    const view = buildOverview(input({ names: { ok: true, names: new Map(Object.entries(NAMES)) }, currency: null }));
    const html = render(view);
    expect(card(html, "ov-top-spenders") ?? "").toContain(esc(FIGURE_UNAVAILABLE_COPY.currency_unknown));
    expect(card(html, "ov-most-visits") ?? "").toContain("Quinn Quoted");
    expect(html).not.toContain('data-figure="ov-highest-spend"');
  });
  it("the printed page leaves the names off and says so", () => {
    const html = render(named(NAMES), { print: true });
    for (const n of Object.values(NAMES)) expect(html).not.toContain(n);
    expect(html).toContain("Client names are left off the printed page.");
    expect(html).not.toContain('data-figure="ov-highest-spend"');
  });
  it("the spreadsheet never carries a name", async () => {
    const { overviewCsv } = await import("@/lib/business-analytics/overview-csv");
    const csv = overviewCsv(named(NAMES), { preparedOn: "2026-11-30" });
    for (const n of Object.values(NAMES)) expect(csv).not.toContain(n);
  });
  it("candidateClientIds is the clients with a completed visit in the period, and only them", async () => {
    const { candidateClientIds } = await import("@/lib/business-analytics/overview-model");
    expect(candidateClientIds(input()).sort()).toEqual(["client-done-noprice", "client-done-over", "client-done-quoted"]);
    expect(candidateClientIds(input({ current: { ok: false, reason: "read_failed" } }))).toEqual([]);
  });
});
