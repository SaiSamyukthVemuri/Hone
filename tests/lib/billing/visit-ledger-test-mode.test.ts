import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// Sam, 27 Nov 2026: the visit's TEST-mode entries are found with the statement's own signal: stripe_livemode === true is live; false, NULL or anything else is test.
const h = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));
const client = () => ({
  from: (table: string) => {
    const q: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "order", "limit"]) q[m] = () => q;
    q.maybeSingle = async () => ({ data: (h.rows[table] ?? [])[0] ?? null, error: null });
    q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: h.rows[table] ?? [], error: null }).then(res);
    return q;
  },
  rpc: async () => ({ data: [{ refunded_cents: h.rows.__refunded ? 4000 : 0, review_open: false }], error: null }),
});
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => client() }));
vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => client() }));

const { loadVisitLedger } = await import("@/lib/billing/visit-payments");

const attempt = (id: string, live: unknown) => ({ id, amount_cents: 10000, status: "succeeded", created_at: "2026-11-27T10:00:00Z", receipt_sent_at: null, refund_status: null, refund_amount_cents: null, stripe_livemode: live });
function seed(live: unknown) {
  h.rows = {
    visit_bills: [{ id: "b", total_cents: 22500, currency: "cad", reference_fee_cents: null, fee_adjustment_reason: null, created_at: "t" }],
    visit_external_payments: [],
    payment_charge_attempts: [attempt("a1", live)],
    payment_refunds: [{ id: "r1", amount_cents: 4000, kind: "payment_reversal", status: "succeeded", attempt_id: "a1", external_payment_id: null, requested_at: "2026-11-27T10:03:00Z", platform_fee_returned_cents: null, legacy: false, source: "hone" }],
    payment_refund_reviews: [],
    __refunded: [1],
  };
}

describe("loadVisitLedger marks TEST-mode card entries with the statement's signal", () => {
  it.each([[true, false], [false, true], [null, true], [undefined, true], ["true", true]])("stripe_livemode %j -> test %j for the card and its refund", async (live, test) => {
    seed(live);
    const out = await loadVisitLedger("s", "ap");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.ledger.cards[0].test === true).toBe(test);
    expect(out.ledger.refunds[0].test === true).toBe(test);
  });
});
