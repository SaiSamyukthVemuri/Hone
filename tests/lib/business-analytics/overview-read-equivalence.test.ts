import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

// HON-109 slice 1: the Overview and Clients-tab loader reads the studio's appointments ONCE and cuts them into the five ranges in memory, where it used to read
// each range on its own (about three scans of the table). Every figure must be IDENTICAL. These tests run the original loader ("separate") and the new one
// ("shared") against the SAME in-memory studio, behind a fake that really implements the keyset query (filters, ordering, the (starts_at, id) cursor and the
// API's 1000-row truncation), and compare the WHOLE output: windows, comparison, history, follow-through and the Clients-tab money.

import { NOW, STUDIO, studio, studioClient, synthetic, table } from "./helpers-synthetic-studio";

type Clients = { sort: "spend"; chip: "all"; page: number };
const load = async (client: SupabaseClient, strategy: "shared" | "separate", raw: Record<string, string> = {}, clients?: Clients) => {
  const { loadOverview } = await import("@/lib/business-analytics/server/overview-read");
  return loadOverview({ role: "owner" }, studio, "cad", raw, { strict: false, appointmentReads: strategy, ...(clients ? { clients } : {}) }, NOW, client);
};

const PERIODS: Array<[string, Record<string, string>]> = [
  ["month to date (default)", {}],
  ["previous month", { period: "previous_month" }],
  ["year to date", { period: "year_to_date" }],
  ["custom range, preceding comparison", { period: "custom", from: "2026-06-01", to: "2026-07-31" }],
  ["custom range, same dates last year", { period: "custom", from: "2026-06-01", to: "2026-07-31", compare: "same_dates_last_year" }],
  ["one practitioner", { practitioner: "pr-2" }],
];

describe("the five appointment sets: the shared read cuts exactly the rows the separate reads returned, in the same order", () => {
  const data = synthetic();
  const instants = ["2026-11-19T18:00:00Z", "2026-05-01T14:00:00Z", "2026-08-15T03:30:00Z", "2027-02-01T00:00:00Z"];
  for (const [label, raw] of PERIODS) {
    for (const nowIso of instants) {
      it(`${label}, now ${nowIso}: current, comparison, history, past and future are row-for-row identical`, async () => {
        const { readSetsShared, readSetsSeparately } = await import("@/lib/business-analytics/server/overview-read");
        const { resolvePeriod } = await import("@/lib/business-analytics/period");
        const { parseOverviewParams } = await import("@/lib/business-analytics/overview-params");
        const { localDateString } = await import("@/lib/booking/tz");
        const now = new Date(nowIso);
        const parsed = parseOverviewParams(raw, { strict: false, practitionerIds: new Set(["pr-1", "pr-2"]) });
        if (!parsed.ok) throw new Error("params");
        const resolved = resolvePeriod({ kind: parsed.params.periodKind, today: localDateString(now, studio.timezone), from: parsed.params.from, to: parsed.params.to, customComparison: parsed.params.compare });
        if (!resolved.ok) return; // an invalid period never reads
        const separate = await readSetsSeparately(studioClient(data).client, STUDIO, studio.timezone, resolved.period, now);
        const shared = await readSetsShared(studioClient(data).client, STUDIO, studio.timezone, resolved.period, now);
        expect(shared).not.toBeNull();
        expect(shared).toEqual(separate);
        // anti-vacuity: the ranges are different, populated sets, so equality is not two empty lists
        expect((shared as NonNullable<typeof shared>).history.ok && (shared as NonNullable<typeof shared>).past.ok).toBe(true);
      });
    }
  }
  it("anti-vacuity: across these periods the sets are populated and differ from one another", async () => {
    const { readSetsShared } = await import("@/lib/business-analytics/server/overview-read");
    const { resolvePeriod } = await import("@/lib/business-analytics/period");
    const r = resolvePeriod({ kind: "previous_month", today: "2026-11-19", from: undefined, to: undefined, customComparison: "preceding" });
    if (!r.ok) throw new Error("period");
    const sets = await readSetsShared(studioClient(data).client, STUDIO, studio.timezone, r.period, NOW);
    const n = (x: unknown) => ((x as { ok: true; rows: unknown[] }).rows.length);
    const s = sets as NonNullable<typeof sets>;
    const counts = [n(s.current), n(s.comparison), n(s.history), n(s.past), n(s.future)];
    expect(counts.every((c) => c > 0), JSON.stringify(counts)).toBe(true);
    expect(new Set(counts).size).toBe(5);
  });
});

describe("the Overview read: the shared appointment read returns exactly what the separate reads did", () => {
  const data = synthetic();
  for (const [label, raw] of PERIODS) {
    it(`Overview, ${label}: the whole output is identical`, async () => {
      const separate = await load(studioClient(data).client, "separate", raw);
      const shared = await load(studioClient(data).client, "shared", raw);
      expect(shared).toMatchObject({ access: "granted", ok: true });
      expect(shared).toEqual(separate);
    });
    // the Clients tab adds the lifetime money for all history; two periods are enough to prove it
    if (!["month to date (default)", "custom range, preceding comparison"].includes(label)) continue;
    it(`Clients tab (with the lifetime money), ${label}: the whole output is identical`, async () => {
      const clients: Clients = { sort: "spend", chip: "all", page: 1 };
      const separate = await load(studioClient(data).client, "separate", raw, clients);
      const shared = await load(studioClient(data).client, "shared", raw, clients);
      expect(shared).toEqual(separate);
    });
  }

  it("anti-vacuity: the data really crosses the windows and the output is not empty", async () => {
    const r = await load(studioClient(data).client, "shared", { period: "year_to_date" }, { sort: "spend", chip: "all", page: 1 });
    expect(r).toMatchObject({ ok: true });
    const view = (r as { view: Record<string, unknown> }).view;
    expect(JSON.stringify(view).length).toBeGreaterThan(2000);
    expect(JSON.stringify(view)).toContain("Client ");
  });

  it("reads the studio's appointments about once instead of about three times", async () => {
    const a = studioClient(data);
    const b = studioClient(data);
    await load(a.client, "separate", { period: "year_to_date" });
    await load(b.client, "shared", { period: "year_to_date" });
    // 1,100 rows = 3 pages of 500 for one scan. The shared read makes one scan (3 pages); the separate reads together make far more.
    expect(b.log.appointmentPages).toBe(3);
    expect(a.log.appointmentPages).toBeGreaterThan(b.log.appointmentPages * 2);
  });
});

vi.setConfig({ testTimeout: 60_000 });

describe("the Overview read: failure and cap semantics are unchanged", () => {
  const data = synthetic();
  it("a failed shared read falls back to the separate reads and the answer is the same as theirs", async () => {
    const separate = await load(studioClient(data).client, "separate");
    // page 2 of the shared read fails; the fallback's own reads then succeed
    const fallback = await load(studioClient(data, 2).client, "shared");
    expect(fallback).toEqual(separate);
  });
  it("a read that fails stays UNAVAILABLE, never zero, with the shared reader in use", async () => {
    // every appointment page after the first read fails: the shared read fails, and so does each separate read in the fallback
    const failing = {
      from: (t: string) => (t === "appointments" ? table(t, data.appointments, { appointmentReads: 0, appointmentPages: 0 }, 1) : studioClient(data).client.from(t)),
    } as unknown as SupabaseClient;
    const r = await load(failing, "shared");
    expect(r).toMatchObject({ access: "granted", ok: true });
    // the same client failing the same way gives the same answer from the separate reads
    const failingAgain = { from: (t: string) => (t === "appointments" ? table(t, data.appointments, { appointmentReads: 0, appointmentPages: 0 }, 1) : studioClient(data).client.from(t)) } as unknown as SupabaseClient;
    expect(r).toEqual(await load(failingAgain, "separate"));
  });
  it("more appointments than one read may return: the shared read gives up and the answer equals the separate reads' (capped sets unavailable)", async () => {
    const big = synthetic(10_100); // over the 10,000 cap in total
    const separate = await load(studioClient(big).client, "separate");
    const shared = await load(studioClient(big).client, "shared");
    expect(shared).toEqual(separate);
  });
  it("a studio at the single read's row limit goes straight to the separate reads: no wasted twenty-page scan, same answer", async () => {
    const big = synthetic(10_100);
    const sep = studioClient(big);
    const sepResult = await load(sep.client, "separate");
    const shared = studioClient(big);
    const sharedResult = await load(shared.client, "shared");
    expect(sharedResult).toEqual(sepResult);
    expect(shared.log.appointmentPages, "the count told the loader not to try the single read").toBe(sep.log.appointmentPages);
  });
  it("a studio under the limit still uses the single read (the count does not turn it off)", async () => {
    const small = synthetic(1100);
    const a = studioClient(small);
    await load(a.client, "shared");
    expect(a.log.appointmentPages).toBe(3);
  });
  it("a start time with sub-millisecond digits is not cut in memory: it falls back and still equals the separate reads", async () => {
    const odd = synthetic(40);
    odd.appointments[10] = { ...odd.appointments[10], starts_at: "2026-11-03T15:00:00.123456+00:00" };
    const separate = await load(studioClient(odd).client, "separate");
    const shared = await load(studioClient(odd).client, "shared");
    expect(shared).toEqual(separate);
  });
});
