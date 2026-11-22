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
    names: { ok: true, names: new Map([["client-a1", "Quinn Quoted"]]) },
    clients: { sort: "spend", chip: "all", page: 1, lifetimeHistory: { ok: true, value: { appointments: [], money: { ok: true, value: { cardRows: [], settlementRows: [], legacyFeeRows: [] } as never } } } },
  }),
});

beforeEach(() => Object.assign(state, { role: "owner", loads: [], result: okRead(), throwOnWho: null, jurisdiction: 0 }));

const ID = "11111111-2222-4333-8444-555555555555";
const get = async (qs = `?practitioner=${ID}&period=custom&from=2026-11-01&to=2026-11-30`) => {
  const { GET } = await import("@/app/(app)/financials/analytics/clients/export.csv/route");
  return GET(new NextRequest(`http://localhost/financials/analytics/clients/export.csv${qs}`));
};

describe("the Clients CSV route", () => {
  it("a non-owner is refused with 403 and nothing is read", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      Object.assign(state, { role, loads: [], jurisdiction: 0 });
      expect((await get()).status, role).toBe(403);
      expect(state.loads, role).toEqual([]);
      expect(state.jurisdiction, role).toBe(0);
    }
  });
  it("is strict: a bad sort, chip or page is a 400 and nothing is read", async () => {
    for (const qs of ["?sort=nope", "?chip=nope", "?page=0", "?sort=name&sort=spend"]) {
      state.loads = [];
      const res = await get(qs);
      expect(res.status, qs).toBe(400);
      expect(state.loads, qs).toEqual([]);
    }
  });
  it("asks the loader in strict mode with the parsed table options", async () => {
    await get("?sort=name&chip=beyond_usual&page=2");
    expect(state.loads[0].opts).toEqual({ strict: true, clients: { sort: "name", chip: "beyond_usual", page: 2 } });
  });
  it("a failed read is 503; the file is counts and totals only, with a period-only name and no name, id or team member", async () => {
    state.result = { access: "granted", ok: false, reason: "read_failed", notices: [] };
    expect((await get()).status).toBe(503);
    state.result = okRead();
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="analytics-clients-2026-11-01-to-2026-11-30.csv"');
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    const body = await res.text();
    const everything = `${body}\n${[...res.headers.entries()].join("\n")}`;
    for (const secret of [ID, "pr-1", "client-a1", "Quinn", "Quoted"]) expect(everything, secret).not.toContain(secret);
    expect(body).toContain("No client is named in this file.");
    expect(body).toContain("Clients seen in this period,1");
  });
});

describe("the Clients CSV route: refusals are 403, failures are 503", () => {
  it("a signed-out or inactive caller is 403, and a failed identity read is 503, not a refusal", async () => {
    const { IdentityRefusalError } = await import("@/lib/supabase/identity-refusal");
    state.throwOnWho = new (IdentityRefusalError as unknown as new (m: string) => Error)("refused");
    expect((await get()).status).toBe(403);
    state.throwOnWho = { digest: "NEXT_REDIRECT;replace;/login;307;" };
    expect((await get()).status).toBe(403);
    state.throwOnWho = new Error("database down");
    const res = await get();
    expect(res.status).toBe(503);
    expect(res.headers.get("Cache-Control")).toBe("no-store, private");
    expect(state.loads).toEqual([]);
  });
  it("a loader that refuses access is a 403 with no body of data, never a 200 or a 503", async () => {
    state.result = { access: "refused" };
    const res = await get();
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
  it("a bad value from the loader is 400, any other failed read is 503", async () => {
    state.result = { access: "granted", ok: false, reason: "bad_request", notices: [] };
    expect((await get()).status).toBe(400);
    for (const reason of ["read_failed", "too_many_appointments", "period_invalid"]) {
      state.result = { access: "granted", ok: false, reason, notices: [] };
      expect((await get()).status, reason).toBe(503);
    }
  });
});

describe("the Clients page", () => {
  const page = async (qs: Record<string, string | string[]> = {}) => {
    const mod = await import("@/app/(app)/financials/analytics/clients/page");
    return mod.default({ searchParams: Promise.resolve(qs) });
  };
  it("a non-owner sees the owner-only sentence and nothing is read, not even the currency", async () => {
    for (const role of ["practitioner", "assistant", ""]) {
      Object.assign(state, { role, loads: [], jurisdiction: 0 });
      expect(JSON.stringify(await page()), role).toContain("owner");
      expect(state.loads, role).toEqual([]);
      expect(state.jurisdiction, role).toBe(0);
    }
  });
  it("an owner is read in lenient mode with the parsed table options; a bad sort falls back and says so", async () => {
    const tree = await page({ sort: "nope", chip: "no_next_booking", page: "2" });
    expect(state.loads[0].opts).toEqual({ strict: false, clients: { sort: "spend", chip: "no_next_booking", page: 2 } });
    expect(renderToStaticMarkup(tree as never)).toContain("The sort order in the address was not recognised");
  });
  it("a failed read shows the honest sentence, not a partial table", async () => {
    state.result = { access: "granted", ok: false, reason: "read_failed", notices: [] };
    const html = renderToStaticMarkup((await page()) as never);
    expect(html).toContain("could not be read");
    expect(html).not.toContain("<table");
  });
});
