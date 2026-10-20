import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-READ-01 PR C remainder - R-32.
//
// refreshAccountStatusFromStripe() preserves the historical "when did this
// studio first finish Stripe onboarding" fact by READING the stored timestamp
// and, if one is already recorded, sending NULL to sync_studio_account_status.
// The RPC applies:
//
//   stripe_onboarding_completed_at = coalesce(p_onboarding_completed_at,
//                                             sps.stripe_onboarding_completed_at)
//
// so a NON-NULL argument OVERWRITES the stored value.
//
// The preserve read captured `data` and discarded `error`. PostgREST leaves
// `data` null on failure, and `existingSettings?.stripe_onboarding_completed_at
// != null` is then false - exactly as it is for a studio that has never
// completed onboarding. A failed read therefore sent the CURRENT snapshot
// timestamp into the RPC and rewrote history: the studio's first-completion
// date silently became "now".
//
// The sibling block in app/api/stripe/webhook/route.ts was fixed in #582. This
// is the last application path with the same collapse.
//
// THE HARNESS MUST REPRESENT FOUR DISTINCT SETTINGS-READ OUTCOMES. If error and
// zero-row cannot be expressed independently, every assertion below is vacuous:
//
//   A. query ERROR                      (data null, error set)
//   B. successful ZERO ROW              (data null, error null)
//   C. row WITH a stored completion     (data {ts}, error null)
//   D. row with a NULL stored completion(data {null}, error null)
//
// B and D are distinct on purpose: "no row at all" and "a row that has never
// completed onboarding" are different states that happen to share an outcome,
// and a fix that conflates them would pass a weaker harness.

class Tripwire extends Error {}

type SettingsOutcome =
  | { kind: "error" }
  | { kind: "zero_row" }
  | { kind: "row"; completedAt: string | null };

const h = vi.hoisted(() => ({
  livemode: true,
  observation: "match",
  provisioningCompleteError: false,
  accountCreates: 0,
  settings: { kind: "zero_row" } as SettingsOutcome,
  // Stripe side
  accountRetrieveThrows: false,
  chargesEnabled: true,
  // RPC side
  syncErr: null as { code: string; message: string } | null,
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  // every settings read, with its filters, so scoping is inspected not trusted
  reads: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
}));

const DB_ERROR = {
  code: "57014",
  message: "canceling statement due to statement timeout",
};

vi.mock("@/lib/stripe/server", () => ({
  STRIPE_CONNECT_COUNTRY: "CA",
  inferStripeLivemode: () => h.livemode,
  getStripe: () => ({
    accounts: {
      create: async () => {
        h.accountCreates++;
        return { id: "acct_created", country: "CA", default_currency: "cad" };
      },
      retrieve: async () => {
        if (h.accountRetrieveThrows) {
          throw new Tripwire("stripe unreachable");
        }
        return {
          id: "acct_test",
          charges_enabled: h.chargesEnabled,
          payouts_enabled: true,
          requirements: { currently_due: [], eventually_due: [], disabled_reason: null },
        };
      },
    },
  }),
}));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const q: Record<string, unknown> = {};
      const settle = () => {
        h.reads.push({ table, filters: [...filters] });
        if (table === "stripe_account_provisioning_attempts") {
          return { data: { payment_country: "CA" }, error: null };
        }
        switch (h.settings.kind) {
          case "error":
            // PostgREST leaves data null on failure - the whole point.
            return { data: null, error: DB_ERROR };
          case "zero_row":
            return { data: null, error: null };
          case "row":
            return {
              data: { stripe_onboarding_completed_at: h.settings.completedAt },
              error: null,
            };
        }
      };
      q.select = () => q;
      q.eq = (col: string, val: unknown) => {
        filters.push([col, val]);
        return q;
      };
      q.maybeSingle = async () => settle();
      q.then = (resolve: (v: unknown) => unknown) => resolve(settle());
      return q;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      h.rpcCalls.push({ name, args });
      if (name === "create_or_claim_stripe_account_provisioning") {
        return { data: { attempt_id: "attempt_fake", out_processing_claim_token: "claim_fake",
          out_idempotency_key: "idempotency_fake", should_execute_stripe_call: true }, error: null };
      }
      if (name === "complete_stripe_account_provisioning") {
        return { data: null, error: h.provisioningCompleteError ? DB_ERROR : null };
      }
      if (name === "record_stripe_account_jurisdiction") {
        return { data: h.observation === "empty" ? null : {
          out_result: h.observation, out_account_country: "CA",
          out_payment_country: "CA", out_matches: h.observation === "match",
        }, error: h.observation === "rpc_failed" ? DB_ERROR : null };
      }
      return { data: null, error: h.syncErr };
    },
  }),
}));

vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: async () => ({ ok: true, jurisdiction: { country: "CA" } }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn() }));

const {
  refreshAccountStatusFromStripe,
  createOrLoadConnectedAccountForStudio,
  PAYMENT_COUNTRY_UNVERIFIED_ERROR,
  ACCOUNT_COUNTRY_MISMATCH_ERROR,
} = await import("@/lib/stripe/account");

const STUDIO = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "acct_test";
const FIRST_COMPLETION = "2026-01-15T09:00:00.000Z";

function call() {
  return refreshAccountStatusFromStripe({
    studioId: STUDIO,
    stripeAccountId: ACCOUNT,
  });
}

function syncCall() {
  return h.rpcCalls.find((c) => c.name === "sync_studio_account_status");
}

beforeEach(() => {
  h.livemode = true;
  h.observation = "match";
  h.provisioningCompleteError = false;
  h.accountCreates = 0;
  h.settings = { kind: "zero_row" };
  h.accountRetrieveThrows = false;
  h.chargesEnabled = true;
  h.syncErr = null;
  h.rpcCalls = [];
  h.reads = [];
});

describe("the harness can tell a failed read from an empty one", () => {
  // Guards every assertion below from being vacuous.
  it("error and zero_row are independently representable", async () => {
    h.settings = { kind: "error" };
    await call().catch(() => {});
    const errRead = h.reads.length;
    h.reads = [];
    h.rpcCalls = [];
    h.settings = { kind: "zero_row" };
    await call().catch(() => {});
    expect(errRead).toBeGreaterThan(0);
    expect(h.reads.length).toBeGreaterThan(0);
    // Same query shape, different outcome - so any behavioural difference the
    // tests below observe is caused by the OUTCOME, not by a different query.
    expect(DB_ERROR.code).toBe("57014");
  });
});

describe("R-32: a failed preserve read must not forge a first-completion time", () => {
  it("does NOT send a non-null onboarding timestamp into the sync RPC", async () => {
    h.settings = { kind: "error" };
    await call().catch(() => {});
    const sync = syncCall();
    // THE DEFECT ORACLE. Pre-fix this RPC ran with
    // p_onboarding_completed_at = <now>, overwriting the stored history.
    if (sync) {
      expect(sync.args.p_onboarding_completed_at).toBeNull();
    }
  });

  it("does not call the sync RPC at all, and fails retryably", async () => {
    h.settings = { kind: "error" };
    await expect(call()).rejects.toThrow();
    expect(syncCall()).toBeUndefined();
  });

  it("the thrown message carries no database text", async () => {
    h.settings = { kind: "error" };
    const err = await call().then(
      () => null,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    expect(err).toBeTruthy();
    expect(err).not.toMatch(/57014|statement timeout|PGRST|supabase|studio_payment_settings/i);
  });
});

describe("clean reads keep their existing semantics exactly", () => {
  it("C. a stored completion is PRESERVED (RPC receives null)", async () => {
    h.settings = { kind: "row", completedAt: FIRST_COMPLETION };
    await call();
    expect(syncCall()?.args.p_onboarding_completed_at).toBeNull();
  });

  it("D. a row whose completion is NULL accepts the snapshot timestamp", async () => {
    h.settings = { kind: "row", completedAt: null };
    await call();
    expect(syncCall()?.args.p_onboarding_completed_at).toBeTruthy();
  });

  it("B. a clean ZERO ROW accepts the snapshot timestamp", async () => {
    h.settings = { kind: "zero_row" };
    await call();
    expect(syncCall()?.args.p_onboarding_completed_at).toBeTruthy();
  });

  it("a snapshot with no completion sends null regardless", async () => {
    // charges not enabled -> accountToStatusSnapshot yields no completion time.
    h.chargesEnabled = false;
    h.settings = { kind: "zero_row" };
    await call();
    expect(syncCall()?.args.p_onboarding_completed_at).toBeNull();
  });
});

describe("unrelated failure semantics are untouched", () => {
  it("a sync RPC failure still throws", async () => {
    h.settings = { kind: "zero_row" };
    h.syncErr = { code: "23505", message: "conflict" };
    await expect(call()).rejects.toThrow();
  });

  it("a Stripe retrieve failure still throws, before any DB work", async () => {
    h.accountRetrieveThrows = true;
    await expect(call()).rejects.toThrow();
    expect(h.reads).toEqual([]);
    expect(h.rpcCalls).toEqual([]);
  });
});

describe("scoping is exact", () => {
  it("the preserve read filters studio_id AND the current stripe_livemode", async () => {
    h.livemode = false;
    h.settings = { kind: "row", completedAt: FIRST_COMPLETION };
    await call();
    const read = h.reads.find((r) => r.table === "studio_payment_settings");
    expect(read?.filters).toContainEqual(["studio_id", STUDIO]);
    expect(read?.filters).toContainEqual(["stripe_livemode", false]);
  });

  it("the sync RPC is invoked for the same studio and mode", async () => {
    h.livemode = true;
    h.settings = { kind: "zero_row" };
    await call();
    expect(syncCall()?.args.p_studio_id).toBe(STUDIO);
    expect(syncCall()?.args.p_stripe_livemode).toBe(true);
  });
});

describe("new account country must be recorded before provisioning succeeds", () => {
  it.each(["rpc_failed", "not_bound", "invalid_input", "empty"])(
    "refuses %s after binding, preserving the created account for reconciliation",
    async (outcome) => {
      h.observation = outcome;
      await expect(createOrLoadConnectedAccountForStudio(STUDIO))
        .rejects.toThrow(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
      expect(h.accountCreates).toBe(1);
      expect(h.rpcCalls.map((c) => c.name)).toEqual([
        "create_or_claim_stripe_account_provisioning",
        "complete_stripe_account_provisioning",
        "record_stripe_account_jurisdiction",
      ]);
      expect(h.rpcCalls[1].args.p_stripe_account_id).toBe("acct_created");
      expect(h.rpcCalls[2].args).toMatchObject({
        p_studio_id: STUDIO, p_stripe_account_id: "acct_created",
        p_stripe_livemode: true, p_country: "CA", p_default_currency: "cad",
      });
    },
  );

  it("succeeds only after the bound account observation matches", async () => {
    await expect(createOrLoadConnectedAccountForStudio(STUDIO)).resolves.toEqual({
      stripeAccountId: "acct_created", livemode: true, alreadyProvisioned: false,
    });
    expect(h.rpcCalls.at(-1)?.name).toBe("record_stripe_account_jurisdiction");
  });

  it("keeps country mismatch refusal", async () => {
    h.observation = "country_conflict";
    await expect(createOrLoadConnectedAccountForStudio(STUDIO))
      .rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(h.accountCreates).toBe(1);
  });

  it("does not observe an account whose binding failed", async () => {
    h.provisioningCompleteError = true;
    await expect(createOrLoadConnectedAccountForStudio(STUDIO)).rejects.toThrow("local binding failed");
    expect(h.rpcCalls.some((c) => c.name === "record_stripe_account_jurisdiction")).toBe(false);
    expect(h.accountCreates).toBe(1);
  });
});
