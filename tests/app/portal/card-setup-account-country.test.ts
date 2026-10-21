import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-CCY-03 (#824). The client portal's "add a card" action saves a card only
// onto an account the studio can CHARGE: in the studio's payment country, with
// no persisted Stripe country conflict (0214). Otherwise a client signs the
// card authorization and saves a card that every charge then refuses.
//
// Drives the real action; the SetupIntent creator is a tripwire, so "allowed"
// is proved by the tripwire firing and "refused" by it never firing.

class Tripwire extends Error {}

const h = vi.hoisted(() => ({
  jurisdiction: { ok: true, jurisdiction: { country: "CA", currency: "cad" } } as unknown,
  settings: {} as Record<string, unknown>,
  setupIntentCalls: 0,
}));

vi.mock("@/lib/consent/current-card-authorization", () => ({
  getCardAuthorizationStatus: async () => ({
    kind: "signed_current",
    signatureId: "sig-1",
    templateId: "tpl-1",
    templateVersion: 3,
    signedAt: "2026-08-01T00:00:00.000Z",
  }),
}));
vi.mock("@/lib/portal/session", () => ({
  getCurrentPortalSession: async () => ({
    studioId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222",
  }),
}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));
vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: async () => h.jurisdiction,
}));
vi.mock("@/lib/stripe/setup-intent", () => ({
  createCardOnFileSetupIntent: async () => {
    h.setupIntentCalls += 1;
    throw new Tripwire("SetupIntent reached");
  },
  getOrCreateStripeCustomerForCardOnFile: async () => ({
    ok: true,
    stripeCustomerId: "cus_test",
  }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    const q: Record<string, unknown> = {};
    let table = "";
    const rows: Record<string, unknown> = {
      clients: { id: "22222222-2222-4222-8222-222222222222", archived_at: null },
    };
    const read = () => ({
      data: table === "studio_payment_settings" ? h.settings : (rows[table] ?? null),
      error: null,
    });
    q.select = () => q;
    q.eq = () => q;
    q.is = () => q;
    q.order = () => q;
    q.limit = () => q;
    q.maybeSingle = async () => read();
    q.single = async () => read();
    q.then = (resolve: (v: unknown) => unknown) => resolve(read());
    return {
      from(t: string) {
        table = t;
        return q;
      },
      rpc: () => {
        throw new Tripwire("unexpected RPC");
      },
    };
  },
}));

const { createCardSetupIntentAction } = await import("@/app/portal/payment-method-actions");

function account(country: string | null, conflict: string | null = null) {
  return {
    stripe_account_id: "acct_test",
    stripe_account_status: "enabled",
    stripe_livemode: false,
    stripe_charges_enabled: true,
    stripe_account_country: country,
    stripe_account_country_conflict: conflict,
  };
}
const CA = { ok: true, jurisdiction: { country: "CA", currency: "cad" } };
const US = { ok: true, jurisdiction: { country: "US", currency: "usd" } };

beforeEach(() => {
  h.setupIntentCalls = 0;
  h.jurisdiction = CA;
  h.settings = account(null);
});

async function refused() {
  const res = await createCardSetupIntentAction();
  expect(h.setupIntentCalls).toBe(0);
  expect(res.ok).toBe(false);
  return res.ok ? "" : res.error;
}

describe("portal add-card follows the account-country verdict", () => {
  it.each([
    ["CA studio, US account (mismatch)", CA, account("US")],
    ["US studio, CA account (mismatch)", US, account("CA")],
    ["US studio, account country never observed", US, account(null)],
    ["CA studio, matching account with a persisted conflict", CA, account("CA", "US")],
    ["US studio, matching account with a persisted conflict", US, account("US", "CA")],
  ])("refused: %s", async (_label, jur, settings) => {
    h.jurisdiction = jur;
    h.settings = settings;
    const message = await refused();
    expect(message).not.toMatch(/country|conflict|stripe_account/i); // no internals to a client
  });

  it("an unreadable jurisdiction is a retry, never assumed Canadian", async () => {
    h.jurisdiction = { ok: false, reason: "read_failed" };
    expect(await refused()).toMatch(/try again/i);
  });

  it.each([
    ["CA studio, legacy account never observed", CA, account(null)],
    ["CA studio, CA account", CA, account("CA")],
    ["US studio, US account", US, account("US")],
  ])("allowed (reaches the SetupIntent): %s", async (_label, jur, settings) => {
    h.jurisdiction = jur;
    h.settings = settings;
    await expect(createCardSetupIntentAction()).rejects.toBeInstanceOf(Tripwire);
    expect(h.setupIntentCalls).toBe(1);
  });
});
