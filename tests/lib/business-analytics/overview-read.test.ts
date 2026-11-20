import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({}) }));

const SERVER_MAX_ROWS = 1000;
type Result = { data: unknown; error: unknown };
type Call = { table: string; method: string; args: unknown[] };

function recording(results: Record<string, Result | Result[]>) {
  const calls: Call[] = [];
  const queues = new Map<string, Result[]>();
  for (const [t, r] of Object.entries(results)) queues.set(t, Array.isArray(r) ? [...r] : [r]);
  const client = {
    from: (table: string) => {
      let asked: number | null = null;
      const chain: unknown = new Proxy(() => undefined, {
        get: (_x, prop) => {
          if (prop === "then")
            return (res: (v: unknown) => void) => {
              const q = queues.get(table) ?? [{ data: [], error: null }];
              const r = q.length > 1 ? q.shift() : q[0];
              // The API's max_rows (1000) truncates silently whatever limit was asked for.
              const cap = Math.min(asked ?? SERVER_MAX_ROWS, SERVER_MAX_ROWS);
              res(r && Array.isArray(r.data) && r.data.length > cap ? { ...r, data: r.data.slice(0, cap) } : r);
            };
          return (...args: unknown[]) => {
            if (prop === "limit" && typeof args[0] === "number") asked = args[0];
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
const ok = (data: unknown): Result => ({ data, error: null });
const studio = { id: "22222222-2222-4222-8222-222222222222", timezone: "America/Toronto" };
const NOW = new Date("2026-11-19T18:00:00Z");
const healthy = (): Record<string, Result | Result[]> => ({
  practitioners: ok([{ id: "pr-1", display_name: "Ada Example", active: true }]),
  appointments: ok([{ id: "a1", client_id: "c1", starts_at: "2026-11-03T15:00:00+00:00", status: "completed", practitioner_id: "pr-1", service_id: null, duration_minutes: 30 }]),
  sessions: ok([]), payment_charge_attempts: ok([]), appointment_settlements: ok([]), manual_fee_charge_attempts: ok([]), services: ok([]),
});
const load = async (role: string, client: SupabaseClient, raw: Record<string, string | string[]> = {}, strict = false, currency: string | null = "cad") => {
  const { loadOverview } = await import("@/lib/business-analytics/server/overview-read");
  return loadOverview({ role }, studio, currency, raw, { strict }, NOW, client);
};

describe("the Overview read: owner gate before any query", () => {
  it("every non-owner role is refused and NO query is made", async () => {
    for (const role of ["practitioner", "assistant", "admin", "", "OWNER"]) {
      const { client, calls } = recording(healthy());
      expect(await load(role, client)).toEqual({ access: "refused" });
      expect(calls, role).toEqual([]);
    }
  });
});

describe("the Overview read: whole or nothing, studio-scoped, never writing", () => {
  it("an owner gets a view; the unread online-booking table is never queried", async () => {
    const { client, calls } = recording(healthy());
    const r = await load("owner", client);
    expect(r).toMatchObject({ access: "granted", ok: true });
    expect(calls.map((c) => c.table)).not.toContain("appointment_payments");
  });
  it("every query is scoped to the studio and none writes", async () => {
    const { client, calls } = recording(healthy());
    await load("owner", client);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(["insert", "update", "upsert", "delete", "rpc"]).not.toContain(c.method);
    const tables = new Set(calls.map((c) => c.table));
    for (const t of tables) {
      const eqs = calls.filter((c) => c.table === t && c.method === "eq" && c.args[0] === "studio_id");
      expect(eqs.length, t).toBeGreaterThan(0);
      for (const e of eqs) expect(e.args[1]).toBe(studio.id);
    }
  });
  it("reads display names for the clients seen in the period only, archived excluded in the query, and shows them", async () => {
    const res = healthy();
    res.clients = ok([{ id: "c1", name: "Ada Client" }]);
    const { client, calls } = recording(res);
    const r = await load("owner", client);
    const nameCalls = calls.filter((c) => c.table === "clients");
    expect(nameCalls.find((c) => c.method === "select")?.args).toEqual(["preferred_name, id, name"]);
    expect(nameCalls.find((c) => c.method === "is")?.args).toEqual(["archived_at", null]);
    expect(nameCalls.find((c) => c.method === "in")?.args).toEqual(["id", ["c1"]]);
    expect(r).toMatchObject({ access: "granted", ok: true });
    const view = (r as { view: { namedClients: { available: boolean; value?: { mostVisits: Array<{ name: string }> } } } }).view;
    expect(view.namedClients.value?.mostVisits.map((x) => x.name)).toEqual(["Ada Client"]);
  });
  it("never reads client names when asked not to (the printed page and the spreadsheet), and still returns the view", async () => {
    const res = healthy();
    res.clients = ok([{ id: "c1", name: "Ada Client" }]);
    const { client, calls } = recording(res);
    const { loadOverview } = await import("@/lib/business-analytics/server/overview-read");
    const r = await loadOverview({ role: "owner" }, studio, "cad", {}, { strict: true, names: false }, NOW, client);
    expect(r).toMatchObject({ access: "granted", ok: true });
    expect(calls.filter((c) => c.table === "clients")).toEqual([]);
  });
  it("a failed name read makes only the named lists unavailable", async () => {
    const res = healthy();
    res.clients = { data: null, error: { message: "boom" } };
    const r = await load("owner", recording(res).client);
    expect(r).toMatchObject({ access: "granted", ok: true });
    const view = (r as { view: { namedClients: unknown; completedVisits: { available: boolean } } }).view;
    expect(view.namedClients).toEqual({ available: false, reason: "read_failed" });
    expect(view.completedVisits.available).toBe(true);
  });
  it("a failed practitioner read fails the whole page, as labels must not be guessed", async () => {
    const res = healthy();
    res.practitioners = { data: null, error: { message: "boom" } };
    expect(await load("owner", recording(res).client)).toEqual({ access: "granted", ok: false, reason: "read_failed", notices: [] });
  });
  it("a failed appointments read makes the figures unavailable with the reason, not zero", async () => {
    const res = healthy();
    res.appointments = { data: null, error: { message: "boom" } };
    const r = await load("owner", recording(res).client);
    expect(r).toMatchObject({ access: "granted", ok: true });
    if (r.access === "granted" && r.ok) {
      expect(r.view.collected).toEqual({ available: false, reason: "read_failed" });
      expect(r.view.completedVisits).toEqual({ available: false, reason: "read_failed" });
    }
  });
  it("appointments read but a money query fails: the visit figures stay and every money figure says why", async () => {
    const res = healthy();
    res.appointment_settlements = { data: null, error: { message: "boom" } };
    const r = await load("owner", recording(res).client);
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.view.completedVisits).toMatchObject({ available: true, value: { count: 1 } });
    expect(r.view.activeClients.available).toBe(true);
    for (const k of ["collected", "averagePaid", "series", "byPractitioner", "serviceValue", "reconciliation"] as const) expect(r.view[k], k).toEqual({ available: false, reason: "read_failed" });
  });
  it("appointments read but a money query returns a full page (the row cap): the same, never a partial total", async () => {
    const { ROW_CAP } = await import("@/lib/dashboard/in-chunks");
    const res = healthy();
    res.appointment_settlements = ok(Array.from({ length: ROW_CAP }, (_, i) => ({ appointment_id: `a${i}`, method: "paid_cash", amount_cents: 100, currency: "cad", quoted_amount_cents: 100 })));
    const r = await load("owner", recording(res).client);
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.view.completedVisits.available).toBe(true);
    expect(r.view.collected).toEqual({ available: false, reason: "read_failed" });
  });
  it("no payment currency: no money, visits still shown", async () => {
    const r = await load("owner", recording(healthy()).client, {}, false, null);
    if (r.access === "granted" && r.ok) {
      expect(r.view.collected).toEqual({ available: false, reason: "currency_unknown" });
      expect(r.view.completedVisits.available).toBe(true);
    } else throw new Error("expected a view");
  });
});

describe("price evidence: what the loader says it read equals what it queried", () => {
  // Each kind of price evidence and the table its candidates come from. A new class has no entry here until someone adds one, and the exhaustive check fails first.
  const SOURCE_TABLE: Record<string, string> = { recorded_at_visit: "appointment_settlements", online_booking: "appointment_payments" };
  it("every class has a declared source, so a new class cannot be added silently", async () => {
    const { PRICE_EVIDENCE_CLASSES } = await import("@/lib/business-analytics/service-value");
    expect(Object.keys(SOURCE_TABLE).sort()).toEqual([...PRICE_EVIDENCE_CLASSES].sort());
  });
  it("a class is listed as read exactly when its source table is queried, and the view shows the rest as not available", async () => {
    const { CLASSES_READ } = await import("@/lib/business-analytics/server/overview-read");
    const { PRICE_EVIDENCE_CLASSES } = await import("@/lib/business-analytics/service-value");
    const { client, calls } = recording(healthy());
    const r = await load("owner", client);
    const queried = new Set(calls.map((c) => c.table));
    for (const c of PRICE_EVIDENCE_CLASSES) expect(CLASSES_READ.includes(c), c).toBe(queried.has(SOURCE_TABLE[c]));
    expect([...CLASSES_READ]).toEqual(["recorded_at_visit"]);
    if (!(r.access === "granted" && r.ok) || !r.view.serviceValue.available) throw new Error("expected a view");
    expect(r.view.serviceValue.value.classes.online_booking).toEqual({ read: false });
    expect(r.view.serviceValue.value.classes.recorded_at_visit.read).toBe(true);
  });
});

describe("the practitioner list is bounded and never truncated", () => {
  const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `pr-${i}`, display_name: `P ${i}`, active: true }));
  const failed = { access: "granted", ok: false, reason: "read_failed", notices: [] };
  it("asks for no more than the server will return", async () => {
    const { client, calls } = recording(healthy());
    await load("owner", client);
    const lim = calls.find((c) => c.table === "practitioners" && c.method === "limit");
    expect(lim?.args[0]).toBe(1000);
  });
  it("999 practitioners is a whole roster", async () => {
    const r = healthy();
    r.practitioners = ok(people(999));
    expect(await load("owner", recording(r).client)).toMatchObject({ access: "granted", ok: true });
  });
  it("a full page of 1000 may have been cut off by the server, so the page fails closed", async () => {
    const r = healthy();
    r.practitioners = ok(people(1000));
    expect(await load("owner", recording(r).client)).toEqual(failed);
  });
  it("a studio with more than 1000 practitioners is cut to 1000 by the server and still fails closed", async () => {
    const r = healthy();
    r.practitioners = ok(people(1500));
    expect(await load("owner", recording(r).client)).toEqual(failed);
  });
});

describe("the history reads", () => {
  const appts = (calls: Call[]) => calls.filter((c) => c.table === "appointments");
  it("reads everything before the window began, everything up to now, and everything from now on, each studio-scoped", async () => {
    const { client, calls } = recording(healthy());
    await load("owner", client, { period: "previous_month" });
    const filters = appts(calls).filter((c) => ["gte", "lt"].includes(c.method)).map((c) => `${c.method}:${String(c.args[1])}`);
    // current + comparison windows (gte+lt each), history (lt only), past (lt only), future (gte only)
    expect(filters.filter((f) => f.startsWith("lt:")).length).toBe(4);
    expect(filters.filter((f) => f.startsWith("gte:")).length).toBe(3);
    for (const c of appts(calls).filter((x) => x.method === "eq" && x.args[0] === "studio_id")) expect(c.args[1]).toBe(studio.id);
  });
  it("history over the appointment cap says so for returning and interval only", async () => {
    const res = healthy();
    // every appointments read returns a full page forever, so each keyset read hits MAX_PAGES: too_many_appointments
    const page = Array.from({ length: 500 }, (_, i) => ({ id: `x${i}`, client_id: "c1", starts_at: `2026-11-03T15:00:${String(i % 60).padStart(2, "0")}+00:00`, status: "completed", practitioner_id: null, service_id: null, duration_minutes: 30 }));
    res.appointments = ok(page);
    const r = await load("owner", recording(res).client);
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.view.returning).toEqual({ available: false, reason: "too_many_appointments" });
    expect(r.view.interval).toEqual({ available: false, reason: "too_many_appointments" });
    expect(r.view.noNextBooking).toEqual({ available: false, reason: "too_many_appointments" });
  });
  it("a past read that succeeds but a future read that fails: no next booking says why, and nothing is thrown", async () => {
    const q = healthy();
    // reads in order: current window, comparison, history, past, future
    q.appointments = [ok([]), ok([]), ok([]), ok([]), { data: null, error: { message: "boom" } }];
    const r = await load("owner", recording(q).client);
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.view.noNextBooking).toEqual({ available: false, reason: "read_failed" });
    expect(r.view.returning.available).toBe(true);
    expect(r.view.completedVisits.available).toBe(true);
  });
  it("the future read at its appointment cap: no next booking says too many appointments, and nothing is thrown", async () => {
    const page = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, client_id: "c1", starts_at: `2026-12-03T15:00:${String(i % 60).padStart(2, "0")}+00:00`, status: "confirmed", practitioner_id: null, service_id: null, duration_minutes: 30 }));
    const q = healthy();
    q.appointments = [ok([]), ok([]), ok([]), ok([]), ok(page)]; // the last entry repeats: every further page is full
    const r = await load("owner", recording(q).client);
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.view.noNextBooking).toEqual({ available: false, reason: "too_many_appointments" });
    expect(r.view.completedVisits.available).toBe(true);
  });
  it("the history read stops at the period's start: it never reads the period's own rows toward the cap", async () => {
    const { utcInstantFromLocal } = await import("@/lib/booking/tz");
    const { client, calls } = recording(healthy());
    await load("owner", client, { period: "custom", from: "2026-11-01", to: "2026-11-10" });
    const startUtc = utcInstantFromLocal("2026-11-01", "00:00", studio.timezone).toISOString();
    // each appointments query is one contiguous run of calls beginning at its select
    const runs: Call[][] = [];
    for (const c of calls.filter((x) => x.table === "appointments")) {
      if (c.method === "select") runs.push([]);
      runs[runs.length - 1].push(c);
    }
    // the comparison read also ends where the period starts, but it has a lower bound; the history read is the one with none
    const ending = runs.filter((r) => r.some((c) => c.method === "lt" && c.args[1] === startUtc));
    const history = ending.filter((r) => !r.some((c) => c.method === "gte"));
    expect(history.length, "exactly one unbounded-below read, and it ends at the period start").toBe(1);
  });
  it("a failed history read leaves the period's own figures alone", async () => {
    const queues = healthy();
    queues.appointments = [ok([]), ok([]), { data: null, error: { message: "boom" } }];
    const r = await load("owner", recording(queues).client);
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.view.returning).toEqual({ available: false, reason: "read_failed" });
    expect(r.view.completedVisits.available).toBe(true);
  });
});

describe("the filter's list of team members", () => {
  it("lists the current team by display name, never a former member, sorted, with no other field", async () => {
    const res = healthy();
    res.practitioners = ok([
      { id: "pr-b", display_name: "Zed", active: true },
      { id: "pr-a", display_name: " Amy ", active: true },
      { id: "pr-x", display_name: "Gone", active: false },
      { id: "pr-n", display_name: null, active: true },
    ]);
    const r = await load("owner", recording(res).client);
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.practitionerOptions).toEqual([
      { id: "pr-a", label: "Amy" },
      { id: "pr-n", label: "Team member" },
      { id: "pr-b", label: "Zed" },
    ]);
  });
});

describe("a selected team member who is no longer active (U2)", () => {
  const roster = () => {
    const res = healthy();
    res.practitioners = ok([
      { id: "pr-a", display_name: "Amy", active: true },
      { id: "pr-x", display_name: "Gone Person", active: false },
    ]);
    return res;
  };
  it("is listed as a Former team member, never by name, so the form cannot say Everyone while the data is filtered", async () => {
    const r = await load("owner", recording(roster()).client, { practitioner: "pr-x" });
    if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
    expect(r.params.practitioner).toEqual({ kind: "one", practitionerId: "pr-x" });
    expect(r.practitionerOptions).toEqual([
      { id: "pr-a", label: "Amy" },
      { id: "pr-x", label: "Former team member" },
    ]);
    expect(JSON.stringify(r.practitionerOptions)).not.toContain("Gone");
  });
  it("the default view and an active selection add nothing", async () => {
    for (const raw of [{}, { practitioner: "pr-a" }] as Array<Record<string, string>>) {
      const r = await load("owner", recording(roster()).client, raw);
      if (!(r.access === "granted" && r.ok)) throw new Error("expected a view");
      expect(r.practitionerOptions).toEqual([{ id: "pr-a", label: "Amy" }]);
    }
  });
});

describe("dates that cannot be used still return the controls' values (page mode)", () => {
  it("a reversed range, a future range and one over 366 days are period_invalid with the submitted dates and the team list; strict is bad_request", async () => {
    for (const raw of [
      { period: "custom", from: "2026-11-20", to: "2026-11-01" },
      { period: "custom", from: "2027-01-01", to: "2027-01-31" },
      { period: "custom", from: "2025-01-01", to: "2026-11-01" },
    ] as Array<Record<string, string>>) {
      const r = await load("owner", recording(healthy()).client, raw);
      expect(r, JSON.stringify(raw)).toMatchObject({ access: "granted", ok: false, reason: "period_invalid" });
      if (!(r.access === "granted" && !r.ok && r.reason === "period_invalid")) throw new Error("expected period_invalid");
      expect(r.params).toMatchObject({ periodKind: "custom", from: raw.from, to: raw.to });
      expect(r.practitionerOptions).toEqual([{ id: "pr-1", label: "Ada Example" }]);
      expect(r.notices.join(" ")).toContain("The dates were not accepted");
      expect(await load("owner", recording(healthy()).client, raw, true)).toMatchObject({ ok: false, reason: "bad_request" });
    }
  });
});

describe("the Overview read: parameters", () => {
  it("a page with a bad value shows the default with a notice; a strict route is refused, with no data query", async () => {
    const page = await load("owner", recording(healthy()).client, { period: "week" });
    expect(page).toMatchObject({ access: "granted", ok: true, notices: [expect.any(String)] });
    const s = recording(healthy());
    expect(await load("owner", s.client, { period: "week" }, true)).toEqual({ access: "granted", ok: false, reason: "bad_request", notices: [] });
    expect(s.calls.map((c) => c.table).filter((t) => t !== "practitioners")).toEqual([]);
  });
  it("a practitioner id is accepted only when it belongs to this studio's practitioner list", async () => {
    const r = await load("owner", recording(healthy()).client, { practitioner: "pr-1" });
    expect(r).toMatchObject({ ok: true, params: { practitioner: { kind: "one", practitionerId: "pr-1" } } });
    const other = await load("owner", recording(healthy()).client, { practitioner: "someone-elses" });
    expect(other).toMatchObject({ ok: true, params: { practitioner: { kind: "all" } }, notices: [expect.any(String)] });
  });
  it("a custom range that is not allowed says why on a page and is refused on a route", async () => {
    const raw = { period: "custom", from: "2026-12-01", to: "2026-12-31" };
    expect(await load("owner", recording(healthy()).client, raw)).toMatchObject({ access: "granted", ok: false, reason: "period_invalid" });
    expect(await load("owner", recording(healthy()).client, raw, true)).toMatchObject({ access: "granted", ok: false, reason: "bad_request" });
  });
});
