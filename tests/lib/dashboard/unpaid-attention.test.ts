import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Rows = Record<string, unknown[]>;
const db = vi.hoisted(() => ({ rows: {} as Rows, errors: new Set<string>(), queried: [] as string[] }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      db.queried.push(table);
      const b: Record<string, unknown> = {};
      const done = () => ({ data: db.errors.has(table) ? null : (db.rows[table] ?? []), error: db.errors.has(table) ? { code: "XX000" } : null });
      for (const m of ["select", "eq", "is", "in", "lte", "gte", "order", "limit"]) b[m] = () => b;
      b.then = (res: (v: unknown) => unknown) => Promise.resolve(done()).then(res);
      return b;
    },
  })),
}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
const juris = vi.hoisted(() => ({ value: { ok: true, jurisdiction: { country: "CA", currency: "cad" } } as unknown }));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({ getStudioPaymentJurisdiction: vi.fn(async () => juris.value) }));

const { loadUnpaidAttention, UNPAID_ROW_CAP } = await import("@/lib/dashboard/unpaid-attention");

const NOW = new Date("2026-11-04T12:00:00Z");
const base = { studioId: "s1", studioTimezone: "America/Toronto", viewerIsOwner: true, now: NOW, windowDays: 90 as number | null };
const appt = (id: string, over: Record<string, unknown> = {}) => ({
  id, client_id: `c-${id}`, service_id: "svc", duration_minutes: 60, ends_at: "2026-11-01T15:00:00Z", status: "completed",
  clients: { name: `Client ${id}`, preferred_name: null }, ...over,
});

beforeEach(() => {
  db.errors.clear();
  db.queried = [];
  juris.value = { ok: true, jurisdiction: { country: "CA", currency: "cad" } };
  db.rows = {
    appointments: [appt("a1")],
    sessions: [{ id: "ss1", appointment_id: "a1" }],
    payment_charge_attempts: [],
    appointment_settlements: [],
    services: [{ id: "svc", name: "Facial", price_cents: 10000 }],
    client_pricing: [],
  };
});

describe("owner-only", () => {
  it("a non-owner is refused before ANY query is issued", async () => {
    const r = await loadUnpaidAttention({ ...base, viewerIsOwner: false });
    expect(r).toEqual({ ok: false });
    expect(db.queried).toEqual([]);
  });
});

describe("the authoritative balance", () => {
  it("nothing paid: the whole quote is owed, in the studio currency", async () => {
    const r = await loadUnpaidAttention(base);
    expect(r).toMatchObject({ ok: true, notReturned: 0, windowDays: 90 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([expect.objectContaining({ appointmentId: "a1", clientName: "Client a1", balance: { kind: "owed", outstandingCents: 10000, currency: "cad" } })]);
  });
  it("a partial card payment leaves the remainder; a refunded part comes back into the balance", async () => {
    db.rows.payment_charge_attempts = [{ session_id: "ss1", status: "succeeded", amount_cents: 6000, refund_status: null, refund_amount_cents: null, currency: "cad" }];
    let r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "owed", outstandingCents: 4000, currency: "cad" });
    db.rows.payment_charge_attempts = [{ session_id: "ss1", status: "succeeded", amount_cents: 6000, refund_status: "succeeded", refund_amount_cents: 2000, currency: "cad" }];
    r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "owed", outstandingCents: 6000, currency: "cad" });
  });
  it("fully paid by card, or by a cash settlement, or waived: the appointment disappears", async () => {
    db.rows.payment_charge_attempts = [{ session_id: "ss1", status: "succeeded", amount_cents: 10000, refund_status: null, refund_amount_cents: null, currency: "cad" }];
    expect(await loadUnpaidAttention(base)).toMatchObject({ ok: true, items: [] });
    db.rows.payment_charge_attempts = [];
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "paid_cash", amount_cents: 10000 }];
    expect(await loadUnpaidAttention(base)).toMatchObject({ ok: true, items: [] });
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "waived", amount_cents: 0 }];
    expect(await loadUnpaidAttention(base)).toMatchObject({ ok: true, items: [] });
  });
  it("a still_owes note cannot create or change an amount", async () => {
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "still_owes", amount_cents: 99999 }];
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "owed", outstandingCents: 10000, currency: "cad" });
  });
  it("an unknown quote is Amount unavailable, never 0 and never dropped", async () => {
    db.rows.services = [{ id: "svc", name: "Facial", price_cents: null }];
    const r = await loadUnpaidAttention(base);
    expect(r).toMatchObject({ ok: true });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "unavailable" });
  });
  it("no provable currency is Amount unavailable", async () => {
    juris.value = { ok: false, reason: "missing" };
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "unavailable" });
  });
  it("a failed service or pricing read makes every quote unknown, not a guessed price", async () => {
    db.errors.add("client_pricing");
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "unavailable" });
  });
});

describe("a failed read is a failed check, never an empty list", () => {
  it.each(["appointments", "sessions", "payment_charge_attempts", "appointment_settlements"])("%s failing", async (table) => {
    db.errors.add(table);
    if (table === "payment_charge_attempts") db.rows.sessions = [{ id: "ss1", appointment_id: "a1" }];
    expect(await loadUnpaidAttention(base)).toEqual({ ok: false });
  });
});

describe("bounds", () => {
  it("All outstanding (windowDays null) reports no window; the row cap says what it cut", async () => {
    db.rows.appointments = Array.from({ length: UNPAID_ROW_CAP + 5 }, (_, i) => appt(`a${i}`));
    db.rows.sessions = [];
    const r = await loadUnpaidAttention({ ...base, windowDays: null });
    expect(r).toMatchObject({ ok: true, windowDays: null });
    if (r.ok) {
      expect(r.items).toHaveLength(UNPAID_ROW_CAP);
      expect(r.notReturned).toBe(5);
    }
  });
});

describe("read-only", () => {
  it("only reads: no insert, update, delete, rpc or upsert exists in the module", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/dashboard/unpaid-attention.ts", "utf8").replace(/\/\/.*$/gm, "");
    expect(src).not.toMatch(/\.(insert|update|delete|upsert|rpc)\(/);
  });
});
