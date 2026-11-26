import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const calls = vi.hoisted(() => ({ jurisdiction: 0, load: [] as unknown[][], role: "owner", result: null as unknown }));

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ practitioner: { role: calls.role }, studio: { id: "studio-1", name: "Example Studio", timezone: "America/Toronto" } }),
}));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: async () => {
    calls.jurisdiction++;
    return { ok: true, jurisdiction: { currency: "cad" } };
  },
}));
vi.mock("@/lib/business-analytics/server/overview-read", () => ({
  loadOverview: async (...args: unknown[]) => {
    calls.load.push(args);
    return calls.result ?? { access: "granted", ok: false, reason: "read_failed", notices: [] };
  },
}));

import BusinessOverviewPage from "@/app/(app)/financials/overview/page";
import { STATEMENTS_OWNER_ONLY } from "@/lib/finance/statement-screen";

const NOC = { refundedInFullCents: 0, unresolvedCount: 0, otherCurrencyCount: 0, excludedCount: 0, unreadableCount: 0 };
const ok = <T,>(value: T) => ({ available: true as const, value });
const point = (key: string, collectedCents: number) => ({ key, collectedCents, completedVisits: 0 });
const view = (over: Record<string, unknown>) => ({
  access: "granted",
  ok: true,
  notices: [],
  params: {},
  practitionerOptions: [],
  view: {
    currentLabel: "Month to date: 1–24 Nov 2026 (24 days)",
    comparisonLabel: "1–24 Oct 2026 (24 days)",
    asOfLocal: "2026-11-24",
    currentRange: { startLocal: "2026-11-01", lastLocal: "2026-11-24" },
    currency: "cad",
    collected: ok({ headlineCents: 607500, change: { kind: "percent", percent: 53.4 }, previousCents: 396000, caveats: NOC }),
    completedVisits: ok({ count: 41 }),
    activeClients: ok({ count: 30 }),
    averagePaid: ok({ averageCents: { known: true, value: 14800 }, excludedUnknownVisits: 0 }),
    series: ok({ unit: "day", points: [point("2026-11-01", 10000)] }),
    previousSeries: ok({ unit: "day", points: [point("2026-10-01", 5000)] }),
    ...over,
  },
});

const render = async (sp: Record<string, string | string[] | undefined> = {}) => renderToStaticMarkup((await BusinessOverviewPage({ searchParams: Promise.resolve(sp) })) as never);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-24T17:00:00Z"));
  Object.assign(calls, { jurisdiction: 0, load: [], role: "owner", result: null });
});
afterEach(() => vi.useRealTimers());

describe("the owner gate comes before any read", () => {
  it("every role but owner sees the owner-only sentence and NO read is made", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      Object.assign(calls, { jurisdiction: 0, load: [], role });
      expect(await render(), role).toContain(STATEMENTS_OWNER_ONLY);
      expect(calls.jurisdiction, role).toBe(0);
      expect(calls.load, role).toHaveLength(0);
    }
  });
});

describe("the figures are in the server-rendered page", () => {
  it("the hero figure, its comparison and the period are in the HTML, before the follow-up groups", async () => {
    calls.result = view({});
    const html = await render();
    expect(html).toContain("Business overview");
    expect(html).toContain("Collected for visits this month");
    expect(html).toContain("Grouped by visit date");
    expect(html).toContain("$6,075");
    expect(html).toContain("+53.4%");
    expect(html).toContain("CAD");
    expect(html.indexOf("$6,075")).toBeLessThan(html.indexOf("Payment follow-up"));
    expect(html).not.toMatch(/animate-spin|role="progressbar"|Loading/i);
  });

  it("reads the Analytics window the selection names, and names no client (no name read)", async () => {
    calls.result = view({});
    await render({ period: "previous_month" });
    expect(calls.load).toHaveLength(1);
    expect(calls.load[0][3]).toEqual({ period: "previous_month" });
    expect(calls.load[0][4]).toMatchObject({ strict: false, names: false });
  });

  it("a chosen month reads that month's whole window", async () => {
    calls.result = view({});
    await render({ period: "month", month: "2026-03" });
    expect(calls.load[0][3]).toEqual({ period: "custom", from: "2026-03-01", to: "2026-03-31", compare: "previous_month" });
  });
});

describe("a studio with no activity", () => {
  it("prints a genuine $0 and 'Not available' for the average, side by side and different", async () => {
    calls.result = view({
      collected: ok({ headlineCents: 0, change: { kind: "none_recorded" }, previousCents: 0, caveats: NOC }),
      completedVisits: ok({ count: 0 }),
      activeClients: ok({ count: 0 }),
      averagePaid: ok({ averageCents: { known: false, reason: "No completed visit has a known payment." }, excludedUnknownVisits: 0 }),
      series: ok({ unit: "day", points: [point("2026-11-01", 0)] }),
      previousSeries: ok({ unit: "day", points: [point("2026-10-01", 0)] }),
    });
    const html = await render();
    expect(html).toMatch(/data-testid="overview-collected" data-cents="0"[^>]*>.*\$0/);
    expect(html).toMatch(/data-testid="overview-visits"[^>]*>.*<strong[^>]*>0</);
    expect(html).toMatch(/data-testid="overview-average"[^>]*>.*Not available/);
    expect(html).toContain("Nothing was collected in 1–24 Oct 2026");
  });
});

describe("a read that fails shows Not available, never $0", () => {
  it("says so in words and prints no money", async () => {
    const html = await render();
    expect(html).toContain('data-testid="overview-read-failed"');
    expect(html).toContain("Not available");
    expect(html).not.toContain("$0");
  });
});

describe("the links keep the period", () => {
  it("Month to date and Last month open Statements for that month; Year to date has no statement link", async () => {
    calls.result = view({});
    expect(await render()).toContain('href="/financials/statement?month=2026-11"');
    expect(await render({ period: "previous_month" })).toContain('href="/financials/statement?month=2026-10"');
    expect(await render({ period: "month", month: "2026-03" })).toContain('href="/financials/statement?month=2026-03"');
    const ytd = await render({ period: "year_to_date" });
    expect(ytd).not.toContain("/financials/statement?month=");
    expect(ytd).toContain("Clients seen year to date");
  });
  it("the period control offers Month to date, Last month, Year to date and Choose month, with the picker bounded to the current month", async () => {
    calls.result = view({});
    const html = await render({ period: "previous_month" });
    for (const w of ["Month to date", "Last month", "Year to date", "Choose month"]) expect(html).toContain(w);
    expect(html).toMatch(/data-period="previous_month"[^>]*aria-current="true"|aria-current="true"[^>]*data-period="previous_month"/);
    expect(html).toContain('type="month"');
    expect(html).toContain('name="period" value="month"');
    expect(html).toMatch(/max="2026-\d\d"/);
  });
  it("an unrecognised period falls back to Month to date and says so", async () => {
    calls.result = view({});
    const html = await render({ period: "bogus" });
    expect(html).toContain("was not recognised, so Month to date is shown");
    expect(calls.load[0][3]).toEqual({ period: "month_to_date" });
  });
});

describe("the headline names its period, and the all-dates tiles say so", () => {
  it("Last month, a chosen month and Year to date", async () => {
    calls.result = view({});
    const last = await render({ period: "previous_month" });
    expect(last).toContain("Collected for visits in October");
    expect(await render({ period: "month", month: "2025-03" })).toContain("Collected for visits in March 2025");
    expect(await render({ period: "year_to_date" })).toContain("Collected for visits this year");
    expect(last).toMatch(/Needs review<small[^>]*>All dates/);
    expect(last).toMatch(/Money owed<small[^>]*>All dates/);
  });
});

describe("Explore analytics carries the same window AND the same comparison", () => {
  it("a chosen month asks Analytics for that month against the previous calendar month, so the percent matches", async () => {
    calls.result = view({});
    const html = await render({ period: "month", month: "2025-03" });
    expect(html).toContain('href="/financials/analytics?period=custom&amp;from=2025-03-01&amp;to=2025-03-31&amp;compare=previous_month"');
    // Last month is compared with the month before it, said in the address so Analytics shows it and Show resubmits it.
    expect(await render({ period: "previous_month" })).toContain('href="/financials/analytics?period=previous_month&amp;compare=previous_month"');
    expect(await render()).toContain('href="/financials/analytics"');
  });
});

describe("the disclosures are on the page, directly under the figure", () => {
  it("an unresolved payment alone: $0 with its sentence between the figure and the comparison, in the first block", async () => {
    calls.result = view({
      collected: ok({ headlineCents: 0, change: { kind: "none_recorded" }, previousCents: 0, caveats: { ...NOC, unresolvedCount: 1 } }),
      completedVisits: ok({ count: 1 }),
    });
    const html = await render();
    const figure = html.indexOf('data-testid="overview-collected"');
    const note = html.indexOf("1 payment record could not be settled either way and is not counted.");
    const cmp = html.indexOf('data-testid="overview-comparison"');
    expect(note).toBeGreaterThan(figure);
    expect(note).toBeLessThan(cmp);
    expect(html).toContain('data-testid="overview-collected-disclosures"');
  });
  it("a clean period has no disclosure block", async () => {
    calls.result = view({});
    const html = await render();
    expect(html).not.toContain("overview-collected-disclosures");
    expect(html).not.toContain("overview-average-disclosure");
  });
  it("one paid visit and nine unknown ones: '10' visits and '$100' average come WITH the sentence about the nine", async () => {
    calls.result = view({
      completedVisits: ok({ count: 10 }),
      averagePaid: ok({ averageCents: { known: true, value: 10000 }, excludedUnknownVisits: 9 }),
    });
    const html = await render();
    expect(html).toMatch(/data-testid="overview-average-disclosure"[^>]*>9 visits awaiting payment confirmation are left out of this average\./);
  });
});
