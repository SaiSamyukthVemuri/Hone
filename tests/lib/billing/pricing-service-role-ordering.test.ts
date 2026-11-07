import { beforeEach, describe, expect, it, vi } from "vitest";

// client_pricing is owner-only through the Data API (0303), so the billing loaders read it on the
// service role. That is safe ONLY because each service-role read sits AFTER an RLS-scoped user-client
// read that proves membership and scope. This pins the ordering: when the scoped read finds nothing
// (another studio, a missing appointment or session), the service-role client is never asked for a price.

type Rows = { data: unknown; error: unknown };
const h = vi.hoisted(() => ({
  user: {} as Record<string, { data: unknown; error: unknown }>,
  adminCalls: [] as Array<{ table: string; eqs: Array<[string, unknown]> }>,
  adminRows: [] as unknown[],
}));

function fake(table: string, rows: () => Rows, record?: (eqs: Array<[string, unknown]>) => void) {
  const eqs: Array<[string, unknown]> = [];
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.order = () => q;
  q.is = () => q;
  q.in = (c: string, v: unknown) => (eqs.push([c, v]), q);
  q.eq = (c: string, v: unknown) => (eqs.push([c, v]), q);
  q.maybeSingle = () => (record?.(eqs), Promise.resolve(rows()));
  q.then = (resolve: (v: Rows) => unknown) => (record?.(eqs), resolve(rows()));
  void table;
  return q;
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (t: string) => fake(t, () => h.user[t] ?? { data: [], error: null }) }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (t: string) =>
      fake(t, () => ({ data: h.adminRows, error: null }), (eqs) => h.adminCalls.push({ table: t, eqs })),
  }),
}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

import { resolveAppointmentQuotedAmountCents } from "@/lib/billing/appointment-settlement";
import { getAuthoritativeSessionPaymentAmount } from "@/lib/billing/authoritative-session-payment";
import { getAppointmentPaymentStates } from "@/lib/billing/appointment-payment-state";

const STUDIO = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";
const APPT = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const PRICE = [{ client_id: CLIENT, service_name: "Cut", price_cents: 7000, notes: null, effective_from: "2026-01-01" }];

beforeEach(() => {
  h.user = {};
  h.adminCalls = [];
  h.adminRows = PRICE;
});

describe("resolveAppointmentQuotedAmountCents", () => {
  it("missing or other-studio appointment (scoped read returns nothing): no price, service role never asked", async () => {
    h.user.appointments = { data: null, error: null };
    expect(await resolveAppointmentQuotedAmountCents(STUDIO, APPT, "UTC")).toBeNull();
    expect(h.adminCalls).toEqual([]);
  });

  it("a failed scoped read: no price, service role never asked", async () => {
    h.user.appointments = { data: null, error: { code: "42501" } };
    expect(await resolveAppointmentQuotedAmountCents(STUDIO, APPT, "UTC")).toBeNull();
    expect(h.adminCalls).toEqual([]);
  });

  it("a visible appointment: the service-role read is pinned to studio AND client and returns the custom price", async () => {
    h.user.appointments = { data: { id: APPT, client_id: CLIENT, duration_minutes: 60, service: { name: "Cut", price_cents: 5000 } }, error: null };
    expect(await resolveAppointmentQuotedAmountCents(STUDIO, APPT, "UTC")).toBe(7000);
    expect(h.adminCalls).toHaveLength(1);
    expect(h.adminCalls[0].table).toBe("client_pricing");
    expect(h.adminCalls[0].eqs).toEqual([["studio_id", STUDIO], ["client_id", CLIENT]]);
  });
});

describe("getAuthoritativeSessionPaymentAmount", () => {
  const args = { studioId: STUDIO, sessionId: SESSION, studioTimezone: "UTC" };

  it("session not visible (other studio / missing): fails closed, service role never asked", async () => {
    h.user.sessions = { data: null, error: null };
    const r = await getAuthoritativeSessionPaymentAmount(args);
    expect(r.ok).toBe(false);
    expect(h.adminCalls).toEqual([]);
  });

  it("appointment lineage mismatch (scoped appointment read empty): fails closed, service role never asked", async () => {
    h.user.sessions = { data: { id: SESSION, client_id: CLIENT, appointment_id: APPT, deleted_at: null }, error: null };
    h.user.appointments = { data: null, error: null };
    const r = await getAuthoritativeSessionPaymentAmount(args);
    expect(r.ok).toBe(false);
    expect(h.adminCalls).toEqual([]);
  });

  it("a visible session and appointment: the service-role read is pinned to studio AND the session's client", async () => {
    h.user.sessions = { data: { id: SESSION, client_id: CLIENT, appointment_id: APPT, deleted_at: null }, error: null };
    h.user.appointments = { data: { id: APPT, duration_minutes: 60, service: { name: "Cut", price_cents: 5000 } }, error: null };
    await getAuthoritativeSessionPaymentAmount(args);
    expect(h.adminCalls).toHaveLength(1);
    expect(h.adminCalls[0].eqs).toEqual([["studio_id", STUDIO], ["client_id", CLIENT]]);
  });
});

describe("getAppointmentPaymentStates (owner display path)", () => {
  it("no appointment visible: service role never asked", async () => {
    h.user.appointments = { data: [], error: null };
    await getAppointmentPaymentStates(STUDIO, [APPT], "UTC", true);
    expect(h.adminCalls).toEqual([]);
  });

  it("a visible appointment: the service-role read carries the studio and only that appointment's client", async () => {
    h.user.appointments = { data: [{ id: APPT, client_id: CLIENT, service_id: null, duration_minutes: 60 }], error: null };
    await getAppointmentPaymentStates(STUDIO, [APPT], "UTC", true);
    const call = h.adminCalls.find((c) => c.table === "client_pricing");
    expect(call).toBeDefined();
    expect(call!.eqs).toEqual([["studio_id", STUDIO], ["client_id", [CLIENT]]]);
  });
});
