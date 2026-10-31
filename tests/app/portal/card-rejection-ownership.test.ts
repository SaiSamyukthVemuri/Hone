import { beforeEach, describe, expect, it, vi } from "vitest";

// Terminal-rejection ownership, proved through the REAL action.
//
// WHY THIS FILE EXISTS
// The structural guard in card-persistence-truth.test.ts pins the shape of the
// ownership query, and the DB lane proves the query PAIR returns the right
// answer — but it re-implements that pair inside the test rather than calling
// the action. Neither closes application-side drift: two negative controls
// (deleting the client_id binding from the ownership query, and returning
// `rejected` without the `if (owner)` proof) survived both lanes while
// reopening a same-studio cross-client status oracle.
//
// This drives `confirmCardPersistedAction` itself against a fake Supabase, so
// the authorization decision under test is the one the application actually
// makes.
//
// A SetupIntent id is NOT authorization. The portal binds a rejection to the
// caller through Hone's own provisioning table (client_stripe_customers, unique
// on account+livemode+customer), and fails CLOSED to "pending" whenever
// ownership cannot be proved.

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

/**
 * Minimal PostgREST-shaped fake. Supports the operators this action uses and
 * nothing else, so an unsupported call fails loudly rather than silently
 * matching everything.
 */
function builder(table: string) {
  const preds: Array<(r: Row) => boolean> = [];
  let capped: number | null = null;
  const chain = {
    select() {
      return chain;
    },
    eq(col: string, value: unknown) {
      // `payload_summary->>key` reads a JSON field as text, exactly as
      // PostgREST does.
      const arrow = col.match(/^(\w+)->>(\w+)$/);
      if (arrow) {
        const [, jsonCol, key] = arrow;
        preds.push((r) => {
          const doc = (r[jsonCol] ?? {}) as Record<string, unknown>;
          const v = doc[key];
          return v !== undefined && v !== null && String(v) === String(value);
        });
        return chain;
      }
      preds.push((r) => r[col] === value);
      return chain;
    },
    not(col: string, op: string, value: unknown) {
      if (op !== "is" || value !== null) {
        throw new Error(`fake supabase: unsupported not(${col}, ${op})`);
      }
      preds.push((r) => (r[col] ?? null) !== null);
      return chain;
    },
    limit(n: number) {
      capped = n;
      return chain;
    },
    rows() {
      let out = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      if (capped != null) out = out.slice(0, capped);
      return out;
    },
    maybeSingle() {
      const out = chain.rows();
      return Promise.resolve({ data: out[0] ?? null, error: null });
    },
    then(resolve: (v: { data: Row[]; error: null }) => unknown) {
      return Promise.resolve({ data: chain.rows(), error: null }).then(
        resolve as never,
      );
    },
  };
  return chain;
}

const fakeAdmin = {
  from(table: string) {
    return builder(table);
  },
};

const { createAdminClient, getCurrentPortalSession } = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  getCurrentPortalSession: vi.fn(),
}));

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient }));
vi.mock("@/lib/portal/session", () => ({ getCurrentPortalSession }));
// Imported by the module under test for other actions; never reached here.
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: vi.fn() }));
vi.mock("@/lib/stripe/setup-intent", () => ({
  createCardOnFileSetupIntent: vi.fn(),
  getOrCreateStripeCustomerForCardOnFile: vi.fn(),
}));
vi.mock("@/lib/consent/current-card-authorization", () => ({
  getCardAuthorizationStatus: vi.fn(),
}));

import { confirmCardPersistedAction } from "@/app/portal/payment-method-actions";

// ---------------------------------------------------------------------------

const STUDIO = "studio-1";
const CLIENT_A = "client-a";
const CLIENT_B = "client-b";
const ACCOUNT = "acct_test_1";
const CUSTOMER_A = "cus_a";
const LIVEMODE = false;
const SETI = "seti_shared_1";

function signInAs(clientId: string, studioId: string = STUDIO) {
  getCurrentPortalSession.mockResolvedValue({ studioId, clientId });
}

/** A processed, terminally-rejected setup_intent.succeeded event. */
function seedRejection(opts: {
  setupIntentId?: string;
  customerId?: string | null;
  accountId?: string | null;
  livemode?: boolean | null;
  processed?: boolean;
} = {}) {
  const {
    setupIntentId = SETI,
    customerId = CUSTOMER_A,
    accountId = ACCOUNT,
    livemode = LIVEMODE,
    processed = true,
  } = opts;
  const summary: Record<string, unknown> = {
    eventType: "setup_intent.succeeded",
    setupIntentId,
    terminalRejection: true,
    opsAlertAttempted: true,
  };
  if (customerId !== null) summary.stripeCustomerId = customerId;
  if (accountId !== null) summary.stripeAccountId = accountId;
  if (livemode !== null) summary.stripeLivemode = livemode;
  tables.stripe_events.push({
    id: `evt-${tables.stripe_events.length + 1}`,
    event_type: "setup_intent.succeeded",
    processed_at: processed ? "2026-08-12T00:00:00Z" : null,
    payload_summary: summary,
  });
}

/** Hone's own provisioning row: this customer belongs to exactly one client. */
function seedCustomerOwnership(clientId: string, customerId = CUSTOMER_A) {
  tables.client_stripe_customers.push({
    studio_id: STUDIO,
    client_id: clientId,
    stripe_account_id: ACCOUNT,
    stripe_livemode: LIVEMODE,
    stripe_customer_id: customerId,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  tables.client_payment_methods = [];
  tables.stripe_events = [];
  tables.client_stripe_customers = [];
  createAdminClient.mockReturnValue(fakeAdmin);
  signInAs(CLIENT_A);
});

async function confirm(setupIntentId = SETI) {
  return confirmCardPersistedAction(setupIntentId);
}

// ---------------------------------------------------------------------------

describe("CASE A — the rightful client sees their own terminal rejection", () => {
  it("returns rejected when the customer on the event resolves to this client", async () => {
    seedRejection();
    seedCustomerOwnership(CLIENT_A);
    await expect(confirm()).resolves.toEqual({ ok: true, state: "rejected" });
  });

  it("carries no internal reason to the browser", async () => {
    seedRejection();
    seedCustomerOwnership(CLIENT_A);
    const res = await confirm();
    expect(Object.keys(res).sort()).toEqual(["ok", "state"]);
    expect(JSON.stringify(res)).not.toMatch(/mismatch|lineage|metadata|reason/i);
  });
});

describe("CASE B — a SAME-STUDIO different client cannot observe it", () => {
  it("client B holding the exact SetupIntent id gets pending, not rejected", async () => {
    // One event, one customer, owned by A. B is in the SAME studio and knows
    // the SetupIntent id — which is exactly the oracle this must refuse.
    seedRejection();
    seedCustomerOwnership(CLIENT_A);

    signInAs(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "rejected" });

    signInAs(CLIENT_B);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });

  it("B's answer is indistinguishable from a SetupIntent that does not exist", async () => {
    // Existence must not leak through a different shape or message.
    seedRejection();
    seedCustomerOwnership(CLIENT_A);
    signInAs(CLIENT_B);
    const known = await confirm(SETI);
    const unknown = await confirm("seti_never_seen");
    expect(known).toEqual(unknown);
  });

  it("holds even when B owns a DIFFERENT customer in the same studio", async () => {
    seedRejection();
    seedCustomerOwnership(CLIENT_A, CUSTOMER_A);
    seedCustomerOwnership(CLIENT_B, "cus_b");
    signInAs(CLIENT_B);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });
});

describe("CASE C — an unbindable rejection never reads as rejected", () => {
  it("no customer on the event → pending", async () => {
    seedRejection({ customerId: null });
    seedCustomerOwnership(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });

  it("no account on the event → pending", async () => {
    seedRejection({ accountId: null });
    seedCustomerOwnership(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });

  it("no livemode on the event → pending", async () => {
    seedRejection({ livemode: null });
    seedCustomerOwnership(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });

  it("customer present but Hone has no provisioning row → pending", async () => {
    seedRejection();
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });

  it("a rejection in the OTHER Stripe mode does not bind", async () => {
    seedRejection({ livemode: !LIVEMODE });
    seedCustomerOwnership(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });

  it("a rejection on a DIFFERENT connected account does not bind", async () => {
    seedRejection({ accountId: "acct_other" });
    seedCustomerOwnership(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });
});

describe("the durable event is the authority", () => {
  it("an UNPROCESSED rejection is not yet terminal", async () => {
    seedRejection({ processed: false });
    seedCustomerOwnership(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });

  it("an active Hone card wins over everything — saved", async () => {
    tables.client_payment_methods.push({
      id: "cpm-1",
      studio_id: STUDIO,
      client_id: CLIENT_A,
      stripe_setup_intent_id: SETI,
      status: "active",
      brand: "visa",
      last4: "4242",
    });
    seedRejection();
    seedCustomerOwnership(CLIENT_A);
    const res = await confirm();
    expect((res as { state: string }).state).toBe("saved");
  });

  it("another client's ACTIVE card is not this caller's saved state", async () => {
    tables.client_payment_methods.push({
      id: "cpm-b",
      studio_id: STUDIO,
      client_id: CLIENT_B,
      stripe_setup_intent_id: SETI,
      status: "active",
      brand: "visa",
      last4: "4242",
    });
    signInAs(CLIENT_A);
    expect(await confirm()).toEqual({ ok: true, state: "pending" });
  });
});

describe("session and input handling", () => {
  it("no portal session → refusal, never a state read", async () => {
    getCurrentPortalSession.mockResolvedValue(null);
    const res = await confirm();
    expect((res as { ok: boolean }).ok).toBe(false);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("a non-SetupIntent id is refused before any query", async () => {
    const res = await confirmCardPersistedAction("cus_not_a_setup_intent");
    expect((res as { ok: boolean }).ok).toBe(false);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
