import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildOverview } from "@/lib/business-analytics/overview-model";
import { resolvePeriod } from "@/lib/business-analytics/period";

const state = vi.hoisted(() => ({
  role: "owner",
  loads: [] as Array<{ raw: unknown; opts: unknown }>,
  result: null as unknown,
  throwOnWho: null as unknown,
  jurisdiction: 0,
}));

vi.mock("@/lib/supabase/queries", () => ({
  requirePractitionerWithStudio: async () => ({ practitioner: { role: state.role }, studio: { id: "studio-1", timezone: "America/Toronto" } }),
  getCurrentPractitionerWithStudio: async () => {
    if (state.throwOnWho) throw state.throwOnWho;
    return { practitioner: { role: state.role }, studio: { id: "studio-1", timezone: "America/Toronto" } };
  },
}));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: async () => {
    state.jurisdiction++;
    return { ok: true, jurisdiction: { currency: "cad" } };
  },
}));
vi.mock("@/lib/business-analytics/server/overview-read", () => ({
  loadOverview: async (_p: unknown, _s: unknown, _c: unknown, raw: unknown, opts: unknown) => {
    state.loads.push({ raw, opts });
    return state.result;
  },
}));

const period = (() => {
  const r = resolvePeriod({ kind: "custom", today: "2026-11-30", from: "2026-11-01", to: "2026-11-30" });
  if (!r.ok) throw new Error(r.error);
  return r.period;
})();
const appts = [{ id: "a1", clientId: "client-a1", startsAt: "2026-11-05T15:00:00Z", status: "completed", practitionerId: "pr-1", serviceId: null, durationMinutes: 60 }];
const okRead = () => ({
  access: "granted",
  ok: true,
  notices: [],
  practitionerOptions: [{ id: "pr-1", label: "Ada Example" }],
  params: { periodKind: "custom", from: "2026-11-01", to: "2026-11-30", compare: "preceding", practitioner: { kind: "one", practitionerId: "pr-1" }, series: "money" },
  view: buildOverview({
    timezone: "America/Toronto", currency: "cad", nowIso: "2026-11-30T20:00:00Z", period, filter: { kind: "one", practitionerId: "pr-1" },
    current: { ok: true, value: { appointments: appts, money: { ok: true, value: { cardRows: [], settlementRows: [{ appointmentId: "a1", method: "paid_cash", amountCents: 5000, currency: "cad", quotedAmountCents: 5000 }], legacyFeeRows: [] } } } },
    comparison: { ok: false, reason: "read_failed" },
    history: { ok: true, value: { appointments: [] } },
    followThrough: { ok: true, value: { past: [], future: [] } },
    practitioners: [{ id: "pr-1", displayName: "Ada Example", active: true }],
    classesRead: ["recorded_at_visit"],
  }),
});

beforeEach(() => Object.assign(state, { role: "owner", loads: [], result: okRead(), throwOnWho: null, jurisdiction: 0 }));

const ID = "11111111-2222-4333-8444-555555555555";
const get = async (qs = `?practitioner=${ID}&period=custom&from=2026-11-01&to=2026-11-30`) => {
  const { GET } = await import("@/app/(app)/financials/analytics/export.csv/route");
  return GET(new NextRequest(`http://localhost/financials/analytics/export.csv${qs}`));
};

describe("the Overview CSV route", () => {
  it("a non-owner is refused with 403 and nothing is read", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      Object.assign(state, { role, loads: [], jurisdiction: 0 });
      const res = await get();
      expect(res.status, role).toBe(403);
      expect(state.loads, role).toEqual([]);
      expect(state.jurisdiction, role).toBe(0);
    }
  });
  it("a signed-out or inactive caller is 403, and a failed identity read is 503, not a refusal", async () => {
    const { IdentityRefusalError } = await import("@/lib/supabase/identity-refusal");
    state.throwOnWho = new (IdentityRefusalError as unknown as new (m: string) => Error)("refused");
    expect((await get()).status).toBe(403);
    state.throwOnWho = new Error("database down");
    expect((await get()).status).toBe(503);
  });
  it("asks the loader in STRICT mode and passes repeated keys through, so a repeated value is a bad request", async () => {
    await get("?period=previous_month&period=year_to_date");
    expect(state.loads[0].opts).toEqual({ strict: true });
    expect(state.loads[0].raw).toEqual({ period: ["previous_month", "year_to_date"] });
  });
  it("a bad value is 400 and a failed read is 503, both uncached and never a partial file", async () => {
    state.result = { access: "granted", ok: false, reason: "bad_request", notices: [] };
    const bad = await get();
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Cache-Control")).toBe("no-store, private");
    state.result = { access: "granted", ok: false, reason: "read_failed", notices: [] };
    expect((await get()).status).toBe(503);
  });
  it("a good request is a CSV download: period-only file name, no-store, nosniff, no team-member id anywhere", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="analytics-2026-11-01-to-2026-11-30.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    const body = await res.text();
    const everything = `${body}\n${[...res.headers.entries()].join("\n")}`;
    for (const secret of [ID, "pr-1", "client-a1", "a1,"]) expect(everything, secret).not.toContain(secret);
    expect(body).toContain("One team member (filtered)");
  });
});

describe("the Overview print page", () => {
  const page = async (qs: Record<string, string | string[]> = { practitioner: ID }) => {
    const mod = await import("@/app/(app)/financials/analytics/print/page");
    return { mod, tree: await mod.default({ searchParams: Promise.resolve(qs) }) };
  };
  it("a non-owner sees the owner-only sentence and nothing is read", async () => {
    for (const role of ["practitioner", "assistant", ""]) {
      Object.assign(state, { role, loads: [], jurisdiction: 0 });
      const { tree } = await page();
      expect(JSON.stringify(tree), role).toContain("owner");
      expect(state.loads, role).toEqual([]);
      expect(state.jurisdiction, role).toBe(0);
    }
  });
  it("is read in strict mode: a printed page says what it was asked for", async () => {
    await page();
    expect(state.loads[0].opts).toEqual({ strict: true });
    state.result = { access: "granted", ok: false, reason: "bad_request", notices: [] };
    const { tree } = await page();
    expect(JSON.stringify(tree)).toContain("nothing is printed");
  });
  it("the printed page says which team member it shows, by name, even though the controls are gone", async () => {
    const { tree } = await page();
    const html = renderToStaticMarkup(tree as never).replace(/&#x27;/g, "'");
    expect(html).toContain("Showing: Ada Example");
    expect(html).not.toContain("Former team member");
    expect(html).toMatch(/<header[^>]*data-statement-header/); // the header that carries the line is the one print keeps
  });
  it("the print DOM carries one link, Back to Analytics: no chart-toggle link is rendered, only hidden", async () => {
    const { tree } = await page();
    const html = renderToStaticMarkup(tree as never);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
    expect(hrefs.filter((h) => h.startsWith("/financials/analytics"))).toHaveLength(1);
    expect(hrefs.filter((h) => /series=/.test(h))).toEqual([]);
    expect(html).not.toContain("Chart shows");
    // the chosen member's id is in the one Back link and nowhere else in the markup
    expect(html.split("pr-1").length - 1).toBe(1);
  });
  it("the title is fixed text and the page carries no controls, no id and the owner-only footer", async () => {
    const { mod, tree } = await page();
    expect((mod.metadata as { title: string }).title).toBe("Analytics (print)");
    const html = renderToStaticMarkup(tree as never);
    expect(html).not.toContain("<form");
    expect(html).not.toMatch(/<option/);
    expect(html).toContain("data-print-footer");
    expect(html).toContain("Only the studio owner is shown this page");
    expect(html).toContain("<details open");
    for (const secret of ["client-a1", "a1,", "pr-2", ID]) expect(html, secret).not.toContain(secret);
    expect(html.replace(/href="[^"]*"/g, "")).not.toContain("pr-1");
  });
});
