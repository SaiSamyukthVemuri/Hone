import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Review 3777890267: a DATABASE READ FAILURE IS NOT AN EMPTY RESULT.
//
// The loader performs three authoritative reads and used to destructure `data`
// only. A failed query was therefore indistinguishable from "no rows".
//
// For client_pricing that was money-moving and fail-OPEN. A client with two
// conflicting current custom prices must resolve to `ambiguous_custom_pricing`
// and BLOCK. If that SELECT failed, `pricingRows ?? []` became an empty pricing
// set, the resolver fell back to the positive MENU price, and the load returned
// a confident `resolved`, which is exactly the state that authorizes charging
// an already-prepared attempt.
//
// The distinction belongs at the loader boundary, not in one caller: this
// loader is shared by the session payment page, Quick Checkout, the prepare
// action and the execution permission check. So these tests drive the real
// loader and assert on what every consumer receives.

type Rows = { data: unknown; error: unknown };

// Per-table scripted responses.
const responses: Record<string, Rows> = {
  sessions: {
    data: {
      id: "sess-1",
      client_id: "client-1",
      appointment_id: "appt-1",
      deleted_at: null,
    },
    error: null,
  },
  appointments: {
    data: {
      id: "appt-1",
      duration_minutes: 30,
      service: { name: "Electrolysis", price_cents: 10_000 },
    },
    error: null,
  },
  client_pricing: { data: [], error: null },
};

// Records whether the pure resolver was reached at all. A load failure must
// short-circuit BEFORE pricing arithmetic happens.
const resolverCalls: unknown[] = [];

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = chain;
      q.eq = chain;
      q.is = chain;
      q.maybeSingle = async () => responses[table];
      // client_pricing is awaited directly (no maybeSingle), so the builder
      // itself must be thenable.
      q.then = (resolve: (v: Rows) => unknown) => resolve(responses[table]);
      return q;
    },
  }),
}));

vi.mock("@/lib/billing/session-payment-amount", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const real = actual.resolveAuthoritativeSessionPaymentAmount as (
    a: unknown,
  ) => unknown;
  return {
    ...actual,
    resolveAuthoritativeSessionPaymentAmount: (a: unknown) => {
      resolverCalls.push(a);
      return real(a);
    },
  };
});

import { getAuthoritativeSessionPaymentAmount } from "@/lib/billing/authoritative-session-payment";

const ARGS = {
  studioId: "studio-1",
  sessionId: "sess-1",
  studioTimezone: "America/Toronto",
};

beforeEach(() => {
  resolverCalls.length = 0;
  responses.sessions = {
    data: {
      id: "sess-1",
      client_id: "client-1",
      appointment_id: "appt-1",
      deleted_at: null,
    },
    error: null,
  };
  responses.appointments = {
    data: {
      id: "appt-1",
      duration_minutes: 30,
      service: { name: "Electrolysis", price_cents: 10_000 },
    },
    error: null,
  };
  responses.client_pricing = { data: [], error: null };
});
afterEach(() => vi.clearAllMocks());

describe("authoritative pricing reads distinguish FAILURE from EMPTY", () => {
  it("A1 sessions query error -> ok:false, resolver never called", async () => {
    responses.sessions = { data: null, error: { message: "boom" } };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(false);
    expect(!load.ok && load.failure.kind).toBe("read_failed");
    expect(resolverCalls).toHaveLength(0);
  });

  it("A2 appointments/service query error -> ok:false, resolver never called", async () => {
    responses.appointments = { data: null, error: { message: "boom" } };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(false);
    expect(!load.ok && load.failure.kind).toBe("read_failed");
    expect(resolverCalls).toHaveLength(0);
  });

  it("A3 client_pricing query error -> ok:false, resolver never called", async () => {
    responses.client_pricing = { data: null, error: { message: "boom" } };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(false);
    expect(!load.ok && load.failure.kind).toBe("read_failed");
    // The resolver must not run on a pricing set we cannot vouch for.
    expect(resolverCalls).toHaveLength(0);
  });

  it("A4 successful sessions query with NO row still means session_not_found", async () => {
    responses.sessions = { data: null, error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(false);
    expect(!load.ok && load.failure.kind).toBe("session_not_found");
  });

  it("A5 successful appointment query with no matching lineage is preserved", async () => {
    responses.appointments = { data: null, error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(false);
    expect(!load.ok && load.failure.kind).toBe("appointment_lineage_mismatch");
  });

  it("A6 client_pricing ZERO ROWS is a valid empty set, the menu price applies", async () => {
    // The whole point of the distinction: this must keep working.
    responses.client_pricing = { data: [], error: null };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(true);
    expect(load.ok && load.result.kind).toBe("resolved");
    expect(load.ok && load.result.kind === "resolved" && load.result.amountCents).toBe(
      10_000,
    );
    expect(resolverCalls).toHaveLength(1);
  });

  it("A7 client_pricing ERROR with a positive menu price MUST NOT resolve to the menu price", async () => {
    // The exact fail-open Codex described. Same menu price as A6; the only
    // difference is that the pricing read failed rather than returned nothing.
    responses.client_pricing = { data: null, error: { message: "boom" } };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(false);
    expect(JSON.stringify(load)).not.toContain("10000");
    expect(resolverCalls).toHaveLength(0);
  });

  it("A8 client_pricing with ambiguous current rows still blocks", async () => {
    responses.client_pricing = {
      data: [
        {
          service_name: "Electrolysis",
          price_cents: 8_000,
          notes: null,
          effective_from: "2026-01-01",
        },
        {
          service_name: "Electrolysis",
          price_cents: 12_000,
          notes: null,
          effective_from: "2026-01-01",
        },
      ],
      error: null,
    };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(true);
    expect(load.ok && load.result.kind).toBe("ambiguous_custom_pricing");
  });

  it("A9 one authoritative custom price resolves, and it wins over the menu", async () => {
    responses.client_pricing = {
      data: [
        {
          service_name: "Electrolysis",
          price_cents: 8_000,
          notes: null,
          effective_from: "2026-01-01",
        },
      ],
      error: null,
    };
    const load = await getAuthoritativeSessionPaymentAmount(ARGS);
    expect(load.ok).toBe(true);
    expect(load.ok && load.result.kind).toBe("resolved");
    expect(load.ok && load.result.kind === "resolved" && load.result.amountCents).toBe(
      8_000,
    );
  });

  it("a read failure never exposes database internals to the practitioner", async () => {
    const { loadFailureMessage } = await import(
      "@/lib/billing/authoritative-session-payment"
    );
    for (const stage of ["session", "appointment", "client_pricing"] as const) {
      const msg = loadFailureMessage({ kind: "read_failed", stage });
      expect(msg).toMatch(/could not be confirmed/i);
      // identical for every stage, and free of internals
      expect(msg).not.toMatch(
        /client_pricing|sessions|appointments|postgres|PGRST|select|boom|studio-1|client-1/i,
      );
    }
  });
});
