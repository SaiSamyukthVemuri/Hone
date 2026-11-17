import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Decision (platform operator, #1483): an explicitly recorded client-specific $0 price takes precedence over a positive
// menu price. The resolver is SHARED, so this changes SESSION PAYMENTS too: the visit becomes `free`. These tests drive the
// REAL session loader and the real decision functions every money-moving consumer uses, and pin that `free` means "no
// attempt row, no Stripe call" here exactly as FREE-01 does for a $0 menu price.

type Rows = { data: unknown; error: unknown };
const responses: Record<string, Rows> = {};

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ((globalThis as { __mkSb?: () => unknown }).__mkSb = () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = chain;
      q.eq = chain;
      q.is = chain;
      q.maybeSingle = async () => responses[table];
      q.then = (resolve: (v: Rows) => unknown) => resolve(responses[table]);
      return q;
    },
  }))(),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => (globalThis as { __mkSb?: () => unknown }).__mkSb!(),
}));

import { getAuthoritativeSessionPaymentAmount } from "@/lib/billing/authoritative-session-payment";
import { decideExecutionPricingPermission } from "@/lib/billing/execution-pricing-permission";
import { decideSessionPaymentPresentation } from "@/lib/billing/ready-control-permission";

const ARGS = { studioId: "studio-1", sessionId: "sess-1", studioTimezone: "America/Toronto", viewerIsOwner: true };
const row = (price_cents: number, effective_from = "2020-01-01") => ({
  service_name: "Electrolysis", price_cents, notes: null, effective_from,
});

beforeEach(() => {
  responses.sessions = { data: { id: "sess-1", client_id: "client-1", appointment_id: "appt-1", deleted_at: null }, error: null };
  responses.appointments = { data: { id: "appt-1", duration_minutes: 30, service: { name: "Electrolysis", price_cents: 10_000 } }, error: null };
  responses.client_pricing = { data: [], error: null };
});

describe("session payment path: an explicit $0 custom price versus a positive menu price", () => {
  it("the real loader returns `free` (was: the menu price, $100.00)", async () => {
    responses.client_pricing = { data: [row(0)], error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(true);
    expect(load.ok && load.result).toEqual({ kind: "free", serviceName: "Electrolysis", durationMinutes: 30 });
  });

  it("a $0 custom price is `free`, so the execution check BLOCKS any prepared attempt: nothing reaches Stripe", async () => {
    responses.client_pricing = { data: [row(0)], error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    const decision = decideExecutionPricingPermission(load);
    expect(decision.allow).toBe(false);
    expect(!decision.allow && decision.error).toMatch(/is free\. No payment is required/);
  });

  it("the page shows the free notice and offers neither a Prepare form nor a Run charge control", async () => {
    responses.client_pricing = { data: [row(0)], error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    const result = load.ok ? load.result : null;
    for (const attemptStatus of [null, "ready"]) {
      const p = decideSessionPaymentPresentation({ attemptStatus, amountResult: result, showPrepareForm: attemptStatus === null });
      expect(p.prepareFormAmount).toBeNull();
      expect(p.runChargeVisible).toBe(false);
      if (attemptStatus === null) expect(p.freeNoticeServiceName).toBe("Electrolysis");
    }
  });

  it("a positive custom price still charges that price; a $0 menu price with a positive custom price still charges the custom price", async () => {
    responses.client_pricing = { data: [row(7_500)], error: null };
    let load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok && load.result).toMatchObject({ kind: "resolved", amountCents: 7_500, source: "custom_pricing" });
    responses.appointments = { data: { id: "appt-1", duration_minutes: 30, service: { name: "Electrolysis", price_cents: 0 } }, error: null };
    load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok && load.result).toMatchObject({ kind: "resolved", amountCents: 7_500 });
  });

  it("a client with CONFLICTING rows ($0 and $50 equally current) is ambiguous: blocked, never free", async () => {
    responses.client_pricing = { data: [row(0), row(5_000)], error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok && load.result.kind).toBe("ambiguous_custom_pricing");
    expect(decideExecutionPricingPermission(load).allow).toBe(false);
  });

  it("a NEGATIVE custom price is invalid: blocked with its own message, not free and not the menu price", async () => {
    responses.client_pricing = { data: [row(-100)], error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok && load.result.kind).toBe("invalid_custom_pricing");
    const decision = decideExecutionPricingPermission(load);
    expect(decision.allow).toBe(false);
    expect(!decision.allow && decision.error).toMatch(/not a usable price/);
    const p = decideSessionPaymentPresentation({ attemptStatus: null, amountResult: load.ok ? load.result : null, showPrepareForm: true });
    expect(p.prepareFormAmount).toBeNull();
    expect(p.freeNoticeServiceName).toBeNull();
    expect(p.unresolvedExplanation).toMatch(/not a usable price/);
  });

  it("the prepare action still returns on `free` BEFORE any payment_charge_attempts write (source order)", () => {
    const src = readFileSync(join(__dirname, "../../../app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts"), "utf8");
    const freeAt = src.indexOf('priced.result.kind === "free"');
    const insertAt = src.indexOf('.from("payment_charge_attempts")', freeAt);
    expect(freeAt).toBeGreaterThan(0);
    expect(insertAt).toBeGreaterThan(freeAt);
  });
});
