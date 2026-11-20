import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { OverviewScreen } from "@/app/(app)/financials/analytics/overview-screen";
import { FIGURE_UNAVAILABLE_COPY, type ReadFailure } from "@/lib/business-analytics/figure";
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
];
const CARD_IDS = CARDS.map(([, id]) => id).sort();
const card = (html: string, id: string) => html.match(new RegExp(`<section[^>]*data-figure="${id}"[^>]*>([\\s\\S]*?)</section>`))?.[1] ?? null;
/** React writes an apostrophe as an entity, so the expected sentence is escaped the same way. */
const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");
const REASONS: ReadFailure[] = ["too_many_appointments", "read_failed", "currency_unknown", "not_reconciled", "no_evidence_read"];

describe("the Overview screen renders the view it is given", () => {
  const html = render(healthy());
  it("shows the collected total with its lines, and the line from service value to collected", () => {
    expect(card(html, "ov-collected-total") ?? "").toContain("$265.00"); // 9000 + 9500 + 3000 + 5000
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
    expect((series.match(/<path /g) ?? []).length).toBe(1); // the previous period could not be read: one line, not an empty second one
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
    expect(ids).toEqual(CARD_IDS);
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

describe("the collected card states its basis (U4)", () => {
  it("carries the money basis note, so the figure is never shown without how it is counted", async () => {
    const { MONEY_BASIS_NOTE } = await import("@/lib/business-analytics/money-metrics");
    expect((card(render(healthy()), "ov-collected-total") ?? "").replace(/&#x27;/g, "'")).toContain(MONEY_BASIS_NOTE);
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

describe("the layout correction (A4)", () => {
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
    expect((screen.match(/<path /g) ?? []).length).toBe(2);
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

describe("review round on A4 (V1 to V5, Codex P2s, population note)", () => {
  const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  const oneDay = (): OverviewView => {
    const view = healthy();
    const series = { available: true, value: { unit: "day", points: [{ key: "2026-11-01", collectedCents: 9000, completedVisits: 1 }] } };
    return { ...view, series, previousSeries: series } as unknown as OverviewView;
  };
  it("Codex P2: a one-point series draws a visible marker (a circle), and its row is still in the data table", () => {
    const c = card(render(oneDay()), "ov-series") ?? "";
    expect((c.match(/<circle[^>]*data-isolated="current"/g) ?? []).length).toBe(1);
    expect((c.match(/<circle[^>]*data-isolated="previous"/g) ?? []).length).toBe(1);
    expect((c.match(/<tr class="border-b border-line\/60"/g) ?? []).length).toBe(1);
    expect(c).toContain("$90.00");
  });
  it("a multi-point series has no isolated marker, because its stroke is visible", () => {
    expect(card(render(healthy()), "ov-series") ?? "").not.toContain("data-isolated");
  });
  it("V1: the screen says the difference from the model's direction, and says nothing when the model has none", () => {
    const v = healthy();
    const c = (d: unknown) => text(card(render({ ...v, collected: { available: true, value: { ...(v.collected as { value: object }).value, difference: d } } } as unknown as OverviewView), "ov-month-collected") ?? "");
    expect(c({ direction: "more", cents: 24800 })).toContain("$248.00 more collected");
    expect(c({ direction: "less", cents: 4000 })).toContain("$40.00 less collected");
    expect(c({ direction: "same", cents: 0 })).toContain("No change in collected");
    expect(c(null)).toContain("The comparison is not available.");
  });
  it("V5: a month-unit series speaks of months, not days", () => {
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
  it("V5: the factor on the page is the one the model uses", () => {
    expect(text(card(render(healthy()), "ov-beyond") ?? "")).toContain(`than ${DEFAULT_BEYOND_USUAL_FACTOR} times`);
  });
});

describe("visual pass fixes on A4", () => {
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
