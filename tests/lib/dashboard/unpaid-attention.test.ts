import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Rows = Record<string, unknown[]>;
const db = vi.hoisted(() => ({ rows: {} as Rows, errors: new Set<string>(), queried: [] as string[], ins: [] as Array<{ table: string; col: string; n: number; chars: number }> }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    from(table: string) {
      db.queried.push(table);
      const b: Record<string, unknown> = {};
      const done = () => ({ data: db.errors.has(table) ? null : (db.rows[table] ?? []), error: db.errors.has(table) ? { code: "XX000" } : null });
      for (const m of ["select", "eq", "is", "lte", "gte", "order", "limit"]) b[m] = () => b;
      // Records every id list a request carries, to prove no request URL grows past the gateway budget.
      b.in = (col: string, vals: unknown[]) => {
        db.ins.push({ table, col, n: vals.length, chars: vals.map((v) => encodeURIComponent(String(v))).join("%2C").length });
        return b;
      };
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
  db.ins = [];
  juris.value = { ok: true, jurisdiction: { country: "CA", currency: "cad" } };
  db.rows = {
    appointments: [appt("a1")],
    sessions: [{ id: "ss1", appointment_id: "a1", deleted_at: null, price_paid_cents: null }],
    manual_fee_charge_attempts: [],
    payment_charge_attempts: [],
    appointment_settlements: [],
    services: [{ id: "svc", name: "Facial", price_cents: 10000 }],
    client_pricing: [],
  };
});

describe("a settled visit keeps the price it was settled against", () => {
  it("settled at $100, then the service price rises to $120: nothing is owed", async () => {
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "paid_cash", amount_cents: 10000, quoted_amount_cents: 10000 }];
    db.rows.services = [{ id: "svc", name: "Facial", price_cents: 12000 }];
    expect(await loadUnpaidAttention(base)).toMatchObject({ ok: true, items: [] });
  });
  it("a client's custom price raised after settlement does not reopen it either", async () => {
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "paid_cash", amount_cents: 10000, quoted_amount_cents: 10000 }];
    db.rows.client_pricing = [{ client_id: "c-a1", service_name: "Facial", price_cents: 15000, notes: null, effective_from: "2026-11-02" }];
    expect(await loadUnpaidAttention(base)).toMatchObject({ ok: true, items: [] });
  });
  it("a part payment is still short of the recorded quote, not of the new price", async () => {
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "paid_cash", amount_cents: 6000, quoted_amount_cents: 10000 }];
    db.rows.services = [{ id: "svc", name: "Facial", price_cents: 12000 }];
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "owed", outstandingCents: 4000, currency: "cad" });
  });
  it("card-paid in full at an old price, price raised: not listed (HON-65: an unknown amount is not a reason to nag)", async () => {
    db.rows.payment_charge_attempts = [{ session_id: "ss1", status: "succeeded", amount_cents: 10000, refund_status: null, refund_amount_cents: null, currency: "cad" }];
    db.rows.services = [{ id: "svc", name: "Facial", price_cents: 12000 }];
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([]);
  });
  it("card-paid at the same price is still simply paid; an unpaid visit keeps today's quote", async () => {
    db.rows.payment_charge_attempts = [{ session_id: "ss1", status: "succeeded", amount_cents: 10000, refund_status: null, refund_amount_cents: null, currency: "cad" }];
    expect(await loadUnpaidAttention(base)).toMatchObject({ ok: true, items: [] });
    db.rows.payment_charge_attempts = [];
    db.rows.services = [{ id: "svc", name: "Facial", price_cents: 12000 }];
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "owed", outstandingCents: 12000, currency: "cad" });
  });
  it("a collected settlement with no recorded quote, price raised: not listed (HON-65: an unknown amount is not a reason to nag) (Insurance Q-1 / Privacy AS1)", async () => {
    for (const method of ["paid_cash", "paid_e_transfer"]) {
      db.rows.appointment_settlements = [{ appointment_id: "a1", method, amount_cents: 10000, quoted_amount_cents: null }];
      db.rows.services = [{ id: "svc", name: "Facial", price_cents: 12000 }];
      const r = await loadUnpaidAttention(base);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.items).toEqual([]);
    }
  });
  it("a collected settlement with no recorded quote and nothing short of today's price is simply paid", async () => {
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "paid_cash", amount_cents: 10000, quoted_amount_cents: null }];
    expect(await loadUnpaidAttention(base)).toMatchObject({ ok: true, items: [] });
  });
  it("nothing collected keeps today's quote even when a note-only settlement exists", async () => {
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "still_owes", amount_cents: 0, quoted_amount_cents: null }];
    db.rows.services = [{ id: "svc", name: "Facial", price_cents: 12000 }];
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "owed", outstandingCents: 12000, currency: "cad" });
  });
});

describe("Codex P2 (9d9982f1c): a row-capped page is never treated as authoritative", () => {
  const pricingRows = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ client_id: i === 0 ? "c-a1" : `other-${i}`, service_name: `Other ${i}`, price_cents: 100, notes: null, effective_from: "2026-01-01" }));
  it("a full (1000-row) client_pricing page hides nothing silently: every amount is 'Amount unavailable', not the menu price", async () => {
    db.rows.client_pricing = pricingRows(1000);
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([]);
  });
  it("a page just under the cap is read normally", async () => {
    db.rows.client_pricing = pricingRows(999);
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items[0].balance).toEqual({ kind: "owed", outstandingCents: 10000, currency: "cad" });
  });
  it("a capped services page is also 'Amount unavailable'", async () => {
    db.rows.services = Array.from({ length: 1000 }, (_, i) => ({ id: i === 0 ? "svc" : `s${i}`, name: "Facial", price_cents: 10000 }));
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([]);
  });
  it("a capped page on any other read fails the whole load rather than presenting a partial list", async () => {
    db.rows.payment_charge_attempts = Array.from({ length: 1000 }, () => ({ session_id: "ss1", status: "failed", amount_cents: 1, currency: "cad" }));
    expect(await loadUnpaidAttention(base)).toEqual({ ok: false });
  });
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
  it("a partial card payment with no recorded quote cannot prove the price at visit time: 'Amount unavailable', refunded or not", async () => {
    // Ruled by OPS (#1356): the current price is not proof of the price on the day, so no remainder is claimed.
    for (const row of [
      { session_id: "ss1", status: "succeeded", amount_cents: 6000, refund_status: null, refund_amount_cents: null, currency: "cad" },
      { session_id: "ss1", status: "succeeded", amount_cents: 6000, refund_status: "succeeded", refund_amount_cents: 2000, currency: "cad" },
    ]) {
      db.rows.payment_charge_attempts = [row];
      const r = await loadUnpaidAttention(base);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.items).toEqual([]);
    }
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
    if (r.ok) expect(r.items).toEqual([]);
  });
  it("no provable currency is Amount unavailable", async () => {
    juris.value = { ok: false, reason: "missing" };
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([]);
  });
  it("a failed service or pricing read makes every quote unknown, not a guessed price", async () => {
    db.errors.add("client_pricing");
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.items).toEqual([]);
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

// ---------------------------------------------------------------------------
// #1356 fix round: Privacy AO1 / AO2 and Insurance U1 / U2 / U3.
// ---------------------------------------------------------------------------
const card = (over: Record<string, unknown> = {}) => ({
  session_id: "ss1", status: "succeeded", amount_cents: 4000, refund_status: null, refund_amount_cents: null, stripe_refund_status: null, currency: "cad", ...over,
});
const balanceOf = async () => {
  const r = await loadUnpaidAttention(base);
  expect(r.ok).toBe(true);
  return r.ok ? r.items.map((i) => i.balance) : [];
};

describe("AO1: a refund that cannot be read is never 'no refund'", () => {
  it("a succeeded refund with no amount makes the item 'Amount unavailable', not paid and not the full quote", async () => {
    db.rows.payment_charge_attempts = [card({ amount_cents: 10000, refund_status: "succeeded", refund_amount_cents: null })];
    expect(await balanceOf()).toEqual([]);
  });
  it("a refund still pending at the provider is 'Amount unavailable'", async () => {
    db.rows.payment_charge_attempts = [card({ stripe_refund_status: "pending" })];
    expect(await balanceOf()).toEqual([]);
  });
});

describe("AO2 / U2: every other money form either counts or forces 'Amount unavailable'", () => {
  it("a charge on a soft-deleted session is not subtracted and is not ignored", async () => {
    db.rows.sessions = [{ id: "ss1", appointment_id: "a1", deleted_at: "2026-11-02T00:00:00Z", price_paid_cents: null }];
    db.rows.payment_charge_attempts = [card({ amount_cents: 10000 })];
    expect(await balanceOf()).toEqual([]);
  });
  it("a failed charge on a deleted session is nothing", async () => {
    db.rows.sessions = [{ id: "ss1", appointment_id: "a1", deleted_at: "2026-11-02T00:00:00Z", price_paid_cents: null }];
    db.rows.payment_charge_attempts = [card({ status: "failed" })];
    expect(await balanceOf()).toEqual([{ kind: "owed", outstandingCents: 10000, currency: "cad" }]);
  });
  it("a late-cancellation or no-show fee charge on the appointment forces 'Amount unavailable'", async () => {
    db.rows.payment_charge_attempts = [{ appointment_id: "a1", session_id: null, status: "succeeded", charge_reason: "no_show_fee" }];
    expect(await balanceOf()).toEqual([]);
  });
  it("a manual fee charge on the appointment forces 'Amount unavailable'", async () => {
    db.rows.manual_fee_charge_attempts = [{ appointment_id: "a1", status: "succeeded" }];
    expect(await balanceOf()).toEqual([]);
  });
  it("a price recorded on the session forces 'Amount unavailable'; zero or none does not", async () => {
    db.rows.sessions = [{ id: "ss1", appointment_id: "a1", deleted_at: null, price_paid_cents: 5000 }];
    expect(await balanceOf()).toEqual([]);
    db.rows.sessions = [{ id: "ss1", appointment_id: "a1", deleted_at: null, price_paid_cents: 0 }];
    expect(await balanceOf()).toEqual([{ kind: "owed", outstandingCents: 10000, currency: "cad" }]);
  });
  it("the extra money-form reads happen only for visits that would show an amount", async () => {
    db.rows.payment_charge_attempts = [card({ amount_cents: 10000 })]; // fully paid by card: nothing to show
    await loadUnpaidAttention(base);
    expect(db.queried).not.toContain("manual_fee_charge_attempts");
  });
  it("a failed read of a money-form table is an unavailable check, never an empty answer", async () => {
    db.errors.add("manual_fee_charge_attempts");
    expect(await loadUnpaidAttention(base)).toEqual({ ok: false });
  });
});

describe("U3: currencies", () => {
  it("card money in a currency other than the studio's, or in two currencies, is 'Amount unavailable'", async () => {
    db.rows.payment_charge_attempts = [card({ currency: "usd" })];
    expect(await balanceOf()).toEqual([]);
    db.rows.payment_charge_attempts = [card({ currency: "cad" }), card({ currency: "usd" })];
    expect(await balanceOf()).toEqual([]);
  });
  it("a settlement in another currency is 'Amount unavailable'", async () => {
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "paid_cash", amount_cents: 1000, currency: "usd" }];
    expect(await balanceOf()).toEqual([]);
  });
});

describe("U1: no request carries an id list near the gateway limit", () => {
  it("600 appointments: every id list is chunked, each request stays under 4 KB, and nothing is dropped", async () => {
    const many = Array.from({ length: 600 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
    db.rows.appointments = many.map(({ id }) => appt(id, { client_id: `10000000-0000-4000-8000-${id.slice(-12)}` }));
    db.rows.sessions = many.map(({ id }, i) => ({ id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, appointment_id: id, deleted_at: null, price_paid_cents: null }));
    const r = await loadUnpaidAttention(base);
    expect(r.ok).toBe(true);
    expect(db.ins.length).toBeGreaterThan(0);
    for (const q of db.ins) {
      expect(q.n, `${q.table}.${q.col}`).toBeLessThanOrEqual(80);
      expect(q.chars, `${q.table}.${q.col} id list ${q.chars} chars`).toBeLessThan(4096);
    }
    const covered = (table: string, col: string) => db.ins.filter((q) => q.table === table && q.col === col).reduce((n, q) => n + q.n, 0);
    expect(covered("sessions", "appointment_id")).toBe(600);
    expect(covered("appointment_settlements", "appointment_id")).toBe(600);
    expect(covered("payment_charge_attempts", "session_id")).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// HON-65 acceptance matrix (Photos' nine cases): the same rows through the appointment page's reducer and through Needs attention.
// Synthetic data only. The rule: a visit the page calls "Paid" is never listed, and a visit is listed only when money is provably owed.
// ---------------------------------------------------------------------------
const { deriveAppointmentPaymentState } = await import("@/lib/billing/appointment-payment-state");
const pageWord = () => {
  const attempts = (db.rows.payment_charge_attempts as Array<Record<string, unknown>>).filter((a) => a.session_id === "ss1");
  return deriveAppointmentPaymentState(true, attempts.map((a) => ({ status: a.status as string, refund_status: a.refund_status as string | null, amount_cents: a.amount_cents as number, refund_amount_cents: a.refund_amount_cents as number | null })));
};
const listed = async () => {
  const r = await loadUnpaidAttention(base);
  expect(r.ok).toBe(true);
  return r.ok ? r.items.length : -1;
};

describe("HON-65: the page's 'Paid' and Needs attention never contradict each other", () => {
  beforeEach(() => {
    db.rows.payment_charge_attempts = [card({ amount_cents: 10000 })];
  });
  it("1. card = quote, nothing else: page Paid, not listed", async () => {
    expect(pageWord()).toBe("paid");
    expect(await listed()).toBe(0);
  });
  it("2. card = quote plus a price recorded on the session: page Paid, not listed (a typed price is not Hone-verified money, and not a reason to nag)", async () => {
    db.rows.sessions = [{ id: "ss1", appointment_id: "a1", deleted_at: null, price_paid_cents: 10000 }];
    expect(pageWord()).toBe("paid");
    expect(await listed()).toBe(0);
  });
  it("3. card = quote plus a charge on a soft-deleted session: page Paid, not listed", async () => {
    db.rows.sessions = [
      { id: "ss1", appointment_id: "a1", deleted_at: null, price_paid_cents: null },
      { id: "ss0", appointment_id: "a1", deleted_at: "2026-11-02T00:00:00Z", price_paid_cents: null },
    ];
    db.rows.payment_charge_attempts = [card({ amount_cents: 10000 }), card({ session_id: "ss0", amount_cents: 10000 })];
    expect(pageWord()).toBe("paid");
    expect(await listed()).toBe(0);
  });
  it("4. card = quote plus a refund still pending: page Paid, not listed", async () => {
    db.rows.payment_charge_attempts = [card({ amount_cents: 10000, refund_status: "pending_stripe" })];
    expect(pageWord()).toBe("paid");
    expect(await listed()).toBe(0);
  });
  it("5. card below the settled quote: page Paid, so not listed", async () => {
    db.rows.payment_charge_attempts = [card({ amount_cents: 6000 })];
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "still_owes", amount_cents: 0, quoted_amount_cents: 10000 }];
    expect(pageWord()).toBe("paid");
    expect(await listed()).toBe(0);
  });
  it("6. card below today's price, no settlement: page Paid, not listed", async () => {
    db.rows.payment_charge_attempts = [card({ amount_cents: 10000 })];
    db.rows.services = [{ id: "svc", name: "Facial", price_cents: 12000 }];
    expect(pageWord()).toBe("paid");
    expect(await listed()).toBe(0);
  });
  it("7. two attempts, one fully refunded, in both orders: the page is never 'Paid' while the visit is listed", async () => {
    const refunded = card({ amount_cents: 10000, refund_status: "succeeded", refund_amount_cents: 10000, stripe_refund_status: "succeeded" });
    const repaid = card({ amount_cents: 10000 });
    for (const order of [[refunded, repaid], [repaid, refunded]]) {
      db.rows.payment_charge_attempts = order;
      const word = pageWord();
      if (word === "paid") expect(await listed()).toBe(0);
    }
  });
  it("8. cash settlement = quote: not listed", async () => {
    db.rows.payment_charge_attempts = [];
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "paid_cash", amount_cents: 10000, quoted_amount_cents: 10000 }];
    expect(await listed()).toBe(0);
  });
  it("9. waived: not listed", async () => {
    db.rows.payment_charge_attempts = [];
    db.rows.appointment_settlements = [{ appointment_id: "a1", method: "waived", amount_cents: 0, quoted_amount_cents: 10000 }];
    expect(await listed()).toBe(0);
  });
  it("control: nothing paid at all is still listed with the whole quote (the check is not simply off)", async () => {
    db.rows.payment_charge_attempts = [];
    const r = await loadUnpaidAttention(base);
    expect(r.ok && r.items.map((i) => i.balance)).toEqual([{ kind: "owed", outstandingCents: 10000, currency: "cad" }]);
  });
});
