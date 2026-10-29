import { beforeEach, describe, expect, it, vi } from "vitest";

// #1035 Codex P1s 4352197742 (P1-A) and 4352197747 (P1-B), the account half.
//
// P1-A. 0214 stamps stripe_account_provisioning_attempts.payment_country on
// every new claim, from the studio's payment jurisdiction, and its column
// comment says accounts.create uses that country and no earlier read. The
// creator passed the deployment-wide STRIPE_CONNECT_COUNTRY instead, so a US
// studio got an immutable CA Express account (or, with STRIPE_CONNECT_COUNTRY=US,
// a CA studio a US one). The creator must read the stamp for ITS claim and
// fail closed BEFORE any Stripe call when it cannot.
//
// P1-B. record_stripe_account_jurisdiction had no application caller, so
// studio_payment_settings.stripe_account_country stayed NULL forever and the
// "refresh the Stripe status" advice for an unconfirmed US account could never
// work. Every place holding an authoritative Account object must record it.
//
// Behavioural: the real module runs against recording stubs.

const h = vi.hoisted(() => ({
  livemode: false,
  claim: null as Record<string, unknown> | null,
  stamp: { data: { payment_country: "US" }, error: null } as { data: unknown; error: unknown },
  createCalls: [] as Array<Record<string, unknown>>,
  createdAccount: { id: "acct_new", country: "US", default_currency: "usd" } as Record<string, unknown>,
  retrieved: {
    id: "acct_bound",
    country: "US",
    default_currency: "usd",
    charges_enabled: true,
    payouts_enabled: true,
    requirements: { currently_due: [], eventually_due: [], disabled_reason: null },
  } as Record<string, unknown>,
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  rpc: {} as Record<string, { data: unknown; error: unknown } | Error>,
}));

vi.mock("@/lib/stripe/server", () => ({
  // Deliberately CA: a creator that still reads the deployment constant
  // creates a CA account for the US-stamped claim below.
  STRIPE_CONNECT_COUNTRY: "CA",
  inferStripeLivemode: () => h.livemode,
  getStripe: () => ({
    accounts: {
      create: async (params: Record<string, unknown>) => {
        h.createCalls.push(params);
        return h.createdAccount;
      },
      retrieve: async () => h.retrieved,
    },
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const settle = () => {
        h.reads.push({ table, filters: [...filters] });
        if (table === "stripe_account_provisioning_attempts") return h.stamp;
        return { data: null, error: null };
      };
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (col: string, val: unknown) => {
        filters.push([col, val]);
        return q;
      };
      q.maybeSingle = async () => settle();
      q.single = async () => settle();
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      if (name === "create_or_claim_stripe_account_provisioning") {
        return { data: [h.claim], error: null };
      }
      const r = h.rpc[name];
      if (r instanceof Error) throw r;
      return r ?? { data: null, error: null };
    },
  }),
}));

const { createOrLoadConnectedAccountForStudio, refreshAccountStatusFromStripe } =
  await import("@/lib/stripe/account");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const OWN_CLAIM = {
  attempt_id: "attempt-1",
  out_status: "processing",
  out_stripe_account_id: null,
  out_stripe_livemode: null,
  out_idempotency_key: "idem-1",
  out_processing_claim_token: "claim-token-1",
  should_execute_stripe_call: true,
  already_provisioned: false,
};
const RECORDED = {
  data: [{ out_result: "recorded", out_account_country: "US", out_payment_country: "US", out_matches: true }],
  error: null,
};

const rpcNames = () => h.rpcCalls.map((c) => c.name);
const rpcCall = (name: string) => h.rpcCalls.find((c) => c.name === name);

beforeEach(() => {
  h.livemode = false;
  h.claim = { ...OWN_CLAIM };
  h.stamp = { data: { payment_country: "US" }, error: null };
  h.createCalls = [];
  h.createdAccount = { id: "acct_new", country: "US", default_currency: "usd" };
  h.retrieved = {
    id: "acct_bound",
    country: "US",
    default_currency: "usd",
    charges_enabled: true,
    payouts_enabled: true,
    requirements: { currently_due: [], eventually_due: [], disabled_reason: null },
  };
  h.reads = [];
  h.rpcCalls = [];
  h.rpc = { record_stripe_account_jurisdiction: RECORDED };
});

describe("P1-A: accounts.create uses the claim's stamped payment_country", () => {
  it("a US-stamped claim creates a US account, not the deployment's CA", async () => {
    await createOrLoadConnectedAccountForStudio(STUDIO);
    expect(h.createCalls).toHaveLength(1);
    expect(h.createCalls[0].country).toBe("US");
  });

  it("a CA-stamped claim creates a CA account", async () => {
    h.stamp = { data: { payment_country: "CA" }, error: null };
    h.createdAccount = { id: "acct_new", country: "CA", default_currency: "cad" };
    await createOrLoadConnectedAccountForStudio(STUDIO);
    expect(h.createCalls[0].country).toBe("CA");
  });

  it("the stamp is read for THIS attempt AND THIS claim token", async () => {
    await createOrLoadConnectedAccountForStudio(STUDIO);
    const read = h.reads.find((r) => r.table === "stripe_account_provisioning_attempts");
    expect(read?.filters).toContainEqual(["id", "attempt-1"]);
    expect(read?.filters).toContainEqual(["processing_claim_token", "claim-token-1"]);
  });

  it.each([
    ["a read error", { data: null, error: { code: "57014", message: "timeout" } }],
    ["no row (another worker re-claimed)", { data: null, error: null }],
    ["a NULL stamp", { data: { payment_country: null }, error: null }],
    ["an unknown country", { data: { payment_country: "GB" }, error: null }],
  ])("%s: no Stripe call, the attempt is marked failed, and it throws", async (_label, stamp) => {
    h.stamp = stamp;
    await expect(createOrLoadConnectedAccountForStudio(STUDIO)).rejects.toThrow();
    expect(h.createCalls).toEqual([]);
    const mark = rpcCall("mark_stripe_account_provisioning_failed");
    expect(mark?.args).toMatchObject({
      p_attempt_id: "attempt-1",
      p_claim_token: "claim-token-1",
      p_error_code: "payment_country_unverified",
    });
    expect(rpcNames()).not.toContain("complete_stripe_account_provisioning");
  });

  it("CONTROL: a claim this worker does not own makes no read and no Stripe call", async () => {
    h.claim = { ...OWN_CLAIM, should_execute_stripe_call: false, out_stripe_account_id: "acct_x" };
    await createOrLoadConnectedAccountForStudio(STUDIO);
    expect(h.createCalls).toEqual([]);
    expect(h.reads).toEqual([]);
  });
});

describe("P1-B: the created account's country is recorded after binding", () => {
  it("records the Account returned by accounts.create, after complete_", async () => {
    const result = await createOrLoadConnectedAccountForStudio(STUDIO);
    const names = rpcNames();
    expect(names.indexOf("record_stripe_account_jurisdiction")).toBeGreaterThan(
      names.indexOf("complete_stripe_account_provisioning"),
    );
    expect(rpcCall("record_stripe_account_jurisdiction")?.args).toEqual({
      p_studio_id: STUDIO,
      p_stripe_account_id: "acct_new",
      p_stripe_livemode: false,
      p_country: "US",
      p_default_currency: "usd",
    });
    expect(result.accountCountryConfirmed).toBe(true);
  });

  it("an rpc error is never reported as confirmed, and the binding still stands", async () => {
    h.rpc.record_stripe_account_jurisdiction = { data: null, error: { code: "XX000", message: "boom" } };
    const result = await createOrLoadConnectedAccountForStudio(STUDIO);
    expect(result.stripeAccountId).toBe("acct_new");
    expect(result.accountCountryConfirmed).toBe(false);
  });

  it.each(["not_bound", "invalid_input"])("%s is not confirmed, and the binding still stands", async (outcome) => {
    h.rpc.record_stripe_account_jurisdiction = {
      data: [{ out_result: outcome, out_account_country: null, out_payment_country: "US", out_matches: null }],
      error: null,
    };
    const result = await createOrLoadConnectedAccountForStudio(STUDIO);
    expect(result.stripeAccountId).toBe("acct_new");
    expect(result.accountCountryConfirmed).toBe(false);
  });

  it.each([
    ["an empty result set", { data: [], error: null }],
    ["a malformed row", { data: [{ out_result: 7 }], error: null }],
  ])("%s is not confirmed, and the binding still stands", async (_label, reply) => {
    h.rpc.record_stripe_account_jurisdiction = reply;
    const result = await createOrLoadConnectedAccountForStudio(STUDIO);
    expect(result.stripeAccountId).toBe("acct_new");
    expect(result.accountCountryConfirmed).toBe(false);
  });
});

describe("P1-B: a refresh records the retrieved account's country", () => {
  const refresh = () =>
    refreshAccountStatusFromStripe({ studioId: STUDIO, stripeAccountId: "acct_bound" });

  it("records after the status sync, for the bound account and mode", async () => {
    await refresh();
    const names = rpcNames();
    expect(names.indexOf("record_stripe_account_jurisdiction")).toBeGreaterThan(
      names.indexOf("sync_studio_account_status"),
    );
    expect(rpcCall("record_stripe_account_jurisdiction")?.args).toEqual({
      p_studio_id: STUDIO,
      p_stripe_account_id: "acct_bound",
      p_stripe_livemode: false,
      p_country: "US",
      p_default_currency: "usd",
    });
  });

  it("an rpc error fails the refresh closed, with no database text", async () => {
    h.rpc.record_stripe_account_jurisdiction = { data: null, error: { code: "XX000", message: "boom" } };
    await expect(refresh()).rejects.toThrow(/^Stripe status refresh succeeded but local sync failed\.$/);
  });

  it("an rpc that throws fails the refresh closed too", async () => {
    h.rpc.record_stripe_account_jurisdiction = new Error("network");
    await expect(refresh()).rejects.toThrow(/^Stripe status refresh succeeded but local sync failed\.$/);
  });

  // #1035 Codex P2 4352568927. These outcomes stored NO observation, so a
  // refresh that resolved after one told the practitioner the country was
  // recorded when it was not. Each must fail the refresh like a failed write.
  it.each([
    ["not_bound", { data: [{ out_result: "not_bound", out_account_country: null, out_payment_country: "US", out_matches: null }], error: null }],
    ["invalid_input", { data: [{ out_result: "invalid_input", out_account_country: null, out_payment_country: null, out_matches: null }], error: null }],
    ["an empty result set", { data: [], error: null }],
    ["a null result", { data: null, error: null }],
    ["a malformed row", { data: [{ out_result: 7 }], error: null }],
    ["an unknown result", { data: [{ out_result: "mystery", out_matches: true }], error: null }],
  ])("P2: %s stored nothing, so the refresh fails closed", async (_label, reply) => {
    h.rpc.record_stripe_account_jurisdiction = reply;
    await expect(refresh()).rejects.toThrow(/^Stripe status refresh succeeded but local sync failed\.$/);
    expect(rpcNames()).toContain("record_stripe_account_jurisdiction");
  });

  it("CONTROL: a refreshed observation that matches still resolves", async () => {
    h.rpc.record_stripe_account_jurisdiction = {
      data: [{ out_result: "refreshed", out_account_country: "US", out_payment_country: "US", out_matches: true }],
      error: null,
    };
    await expect(refresh()).resolves.toMatchObject({ chargesEnabled: true });
  });

  it("a persisted country_conflict is a non-chargeable answer, not an error", async () => {
    h.rpc.record_stripe_account_jurisdiction = {
      data: [{ out_result: "country_conflict", out_account_country: "CA", out_payment_country: "US", out_matches: false }],
      error: null,
    };
    const snapshot = await refresh();
    expect(snapshot.chargesEnabled).toBe(true);
    expect(rpcNames()).toContain("record_stripe_account_jurisdiction");
  });
});
