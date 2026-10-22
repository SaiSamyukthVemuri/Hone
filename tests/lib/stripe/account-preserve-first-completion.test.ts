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
  accountLinks: 0,
  boundAccountId: null as string | null,
  recordedCountry: null as string | null,
  countryConflict: null as string | null,
  alertClaimError: false,
  alertClaimThrows: false,
  alertResult: null as string | null,
  alertRows: [] as Array<{ key: string; resolved: boolean }>,
  settings: { kind: "zero_row" } as SettingsOutcome,
  // Stripe side
  accountRetrieveThrows: false,
  returnedAccountId: "acct_test" as string | undefined,
  retrieveCalls: [] as string[],
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
    accountLinks: { create: async () => {
      h.accountLinks++;
      return { url: "https://stripe.invalid/onboarding" };
    } },
    accounts: {
      create: async () => {
        h.accountCreates++;
        return { id: "acct_created", country: "CA", default_currency: "cad" };
      },
      retrieve: async (accountId: string) => {
        h.retrieveCalls.push(accountId);
        if (h.accountRetrieveThrows) {
          throw new Tripwire("stripe unreachable");
        }
        return {
          id: h.returnedAccountId,
          country: "CA",
          default_currency: "cad",
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
        if (h.boundAccountId && h.settings.kind !== "error") {
          return { data: { stripe_account_country: h.recordedCountry,
            stripe_account_country_conflict: h.countryConflict }, error: null };
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
        if (h.boundAccountId) return { data: { already_provisioned: true,
          out_stripe_account_id: h.boundAccountId, out_stripe_livemode: h.livemode }, error: null };
        return { data: { attempt_id: "attempt_fake", out_processing_claim_token: "claim_fake",
          out_idempotency_key: "idempotency_fake", should_execute_stripe_call: true }, error: null };
      }
      if (name === "complete_stripe_account_provisioning") {
        if (!h.provisioningCompleteError) h.boundAccountId = String(args.p_stripe_account_id);
        return { data: null, error: h.provisioningCompleteError ? DB_ERROR : null };
      }
      if (name === "record_stripe_account_jurisdiction") {
        if (h.observation === "match") h.recordedCountry = "CA";
        return { data: h.observation === "empty" ? null : {
          out_result: h.observation, out_account_country: "CA",
          out_payment_country: "CA", out_matches: h.observation === "match",
        }, error: h.observation === "rpc_failed" ? DB_ERROR : null };
      }
      if (name === "claim_stripe_account_country_alert") {
        if (h.alertClaimThrows) throw new Tripwire("claim unavailable");
        if (h.alertClaimError) return { data: null, error: DB_ERROR };
        const reason = h.observation === "country_conflict" ? "country_conflict" : "country_mismatch";
        const key = JSON.stringify([args.p_studio_id, args.p_stripe_account_id, args.p_stripe_livemode, reason]);
        const existing = h.alertRows.find((r) => r.key === key && !r.resolved);
        const result = h.alertResult ?? (existing ? "existing" : "created");
        if (result === "created") h.alertRows.push({ key, resolved: false });
        return { data: { out_result: result, out_alert_id: "11111111-1111-4111-8111-111111111112",
          out_created_at: "2026-10-20T00:00:00.000Z", out_reason: reason,
          out_message: "Country incident from trusted persisted state." }, error: null };
      }
      return { data: null, error: h.syncErr };
    },
  }),
}));

vi.mock("@/lib/billing/payment-jurisdiction-server", () => ({
  getStudioPaymentJurisdiction: async () => ({ ok: true, jurisdiction: { country: "CA" } }),
}));
vi.mock("@/lib/ops/alerts", () => ({ recordOpsAlert: vi.fn() }));
vi.mock("@/lib/ops/alert-email", () => ({ notifyCriticalOpsAlert: vi.fn(async () => undefined) }));
import { notifyCriticalOpsAlert } from "@/lib/ops/alert-email";
import { recordOpsAlert } from "@/lib/ops/alerts";

const {
  refreshAccountStatusFromStripe,
  createOrLoadConnectedAccountForStudio,
  createConnectOnboardingLink,
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
  h.accountLinks = 0;
  h.boundAccountId = null;
  h.recordedCountry = null;
  h.countryConflict = null;
  h.alertRows = [];
  h.alertClaimError = false;
  h.alertClaimThrows = false;
  h.alertResult = null;
  vi.mocked(notifyCriticalOpsAlert).mockReset().mockResolvedValue(undefined);
  vi.mocked(recordOpsAlert).mockClear();
  h.settings = { kind: "zero_row" };
  h.accountRetrieveThrows = false;
  h.returnedAccountId = "acct_test";
  h.retrieveCalls = [];
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


describe("bound retries cannot bypass an unrecorded country", () => {
  async function onboard() {
    const result = await createOrLoadConnectedAccountForStudio(STUDIO);
    return createConnectOnboardingLink({ stripeAccountId: result.stripeAccountId,
      appOrigin: "https://hone.invalid" });
  }

  it.each(["rpc_failed", "not_bound", "invalid_input", "empty"])(
    "keeps %s blocked on bound retry, then reuses the account after verified refresh",
    async (outcome) => {
      h.observation = outcome;
      await expect(onboard()).rejects.toThrow(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
      expect(h.boundAccountId).toBe("acct_created");
      expect(h.recordedCountry).toBeNull();
      await expect(onboard()).rejects.toThrow(PAYMENT_COUNTRY_UNVERIFIED_ERROR);
      expect(h.boundAccountId).toBe("acct_created");
      expect(h.accountCreates).toBe(1);
      expect(h.accountLinks).toBe(0);
      expect(h.rpcCalls.filter((c) => c.name === "complete_stripe_account_provisioning")).toHaveLength(1);
      expect(h.rpcCalls.some((c) => c.name === "mark_stripe_account_provisioning_failed")).toBe(false);
      const read = h.reads.find((r) => r.table === "studio_payment_settings");
      expect(read?.filters).toEqual([["studio_id", STUDIO], ["stripe_livemode", true],
        ["stripe_account_id", "acct_created"]]);
      h.observation = "match";
      // The #1042 identity guard requires the retrieved account to be the bound one.
      h.returnedAccountId = "acct_created";
      await refreshAccountStatusFromStripe({ studioId: STUDIO, stripeAccountId: "acct_created" });
      expect(h.recordedCountry).toBe("CA");
      await expect(onboard()).resolves.toBe("https://stripe.invalid/onboarding");
      expect(h.accountCreates).toBe(1);
      expect(h.accountLinks).toBe(1);
    },
  );

  it.each(["mismatch", "conflict", "unread"])("keeps a bound %s account blocked", async (outcome) => {
    h.boundAccountId = "acct_created";
    h.recordedCountry = outcome === "mismatch" ? "US" : "CA";
    if (outcome === "conflict") h.countryConflict = "US";
    if (outcome === "unread") h.settings = { kind: "error" };
    await expect(onboard()).rejects.toThrow(outcome === "unread"
      ? PAYMENT_COUNTRY_UNVERIFIED_ERROR : ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(h.accountCreates).toBe(0);
    expect(h.accountLinks).toBe(0);
    expect(h.boundAccountId).toBe("acct_created");
  });
});


describe("0238 country incident created-winner dispatch", () => {
  it.each(["refreshed", "country_conflict"])("%s first/repeated/concurrent verdicts keep one incident and notification", async (outcome) => {
    h.observation = outcome;
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(h.alertRows).toHaveLength(1);
    expect(notifyCriticalOpsAlert).toHaveBeenCalledTimes(1);
    const repeats = await Promise.allSettled([call(), call()]);
    expect(repeats.every((r) => r.status === "rejected")).toBe(true);
    expect(h.alertRows).toHaveLength(1);
    expect(notifyCriticalOpsAlert).toHaveBeenCalledTimes(1);
    expect(recordOpsAlert).not.toHaveBeenCalled();
    expect(h.rpcCalls.filter((c) => c.name === "claim_stripe_account_country_alert").map((c) => c.args))
      .toEqual(Array.from({ length: 3 }, () => ({ p_studio_id: STUDIO,
        p_stripe_account_id: ACCOUNT, p_stripe_livemode: true })));
    expect(notifyCriticalOpsAlert).toHaveBeenCalledWith({ event: "stripe_account_country_mismatch",
      message: "Country incident from trusted persisted state.", createdAtIso: "2026-10-20T00:00:00.000Z",
      studioId: STUDIO, route: "lib/stripe/account:recordStripeAccountObservation" });
  });

  it("a new conflict is independent of a prior mismatch; operator resolution re-arms it", async () => {
    h.observation = "refreshed";
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    h.observation = "country_conflict";
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(h.alertRows).toHaveLength(2);
    expect(notifyCriticalOpsAlert).toHaveBeenCalledTimes(2);
    h.alertRows[1].resolved = true;
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(h.alertRows).toHaveLength(3);
    expect(notifyCriticalOpsAlert).toHaveBeenCalledTimes(3);
  });

  it.each(["rpc", "throw", "unverified", "not_bound", "empty"])("claim %s failure emits no phantom email and never bypasses refusal", async (outcome) => {
    h.observation = "country_conflict";
    h.alertClaimError = outcome === "rpc";
    h.alertClaimThrows = outcome === "throw";
    if (!["rpc", "throw"].includes(outcome)) h.alertResult = outcome;
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
      expect(h.alertRows).toHaveLength(0);
      expect(notifyCriticalOpsAlert).not.toHaveBeenCalled();
      expect(recordOpsAlert).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalled();
    } finally { log.mockRestore(); }
  });

  it("a rolled-back claim can retry and matching recovery emits no further incident", async () => {
    h.observation = "country_conflict";
    h.alertClaimError = true;
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    h.alertClaimError = false;
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(notifyCriticalOpsAlert).toHaveBeenCalledTimes(1);
    h.observation = "match"; // Only after legitimate persisted conflict resolution.
    await call();
    expect(h.alertRows).toHaveLength(1);
    expect(notifyCriticalOpsAlert).toHaveBeenCalledTimes(1);
  });

  it("email failure preserves durable incident and country refusal without repeated mail", async () => {
    h.observation = "country_conflict";
    vi.mocked(notifyCriticalOpsAlert).mockRejectedValueOnce(new Tripwire("email unavailable"));
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    await expect(call()).rejects.toThrow(ACCOUNT_COUNTRY_MISMATCH_ERROR);
    expect(h.alertRows).toHaveLength(1);
    expect(notifyCriticalOpsAlert).toHaveBeenCalledTimes(1);
    expect(recordOpsAlert).not.toHaveBeenCalled();
  });

  it.each(["match", "rpc_failed", "not_bound", "invalid_input"])("observation %s does not claim a mismatch incident", async (outcome) => {
    h.observation = outcome;
    await call().catch(() => undefined);
    expect(h.rpcCalls.some((c) => c.name === "claim_stripe_account_country_alert")).toBe(false);
    expect(notifyCriticalOpsAlert).not.toHaveBeenCalled();
  });
});


describe("owner refresh verifies retrieved account identity before any local status", () => {
  it.each(["acct_other", undefined])("returned id %s refuses before preserve read and status synchronization", async (id) => {
    h.returnedAccountId = id;
    await expect(refreshAccountStatusFromStripe({ studioId: STUDIO, stripeAccountId: "acct_test" }))
      .rejects.toThrow("Could not refresh status from Stripe. Try again.");
    expect(h.retrieveCalls).toEqual(["acct_test"]);
    expect(h.reads).toEqual([]);
    expect(h.rpcCalls).toEqual([]);
  });
  it("correct identity retains one same SDK request and legitimate first-completion synchronization", async () => {
    h.settings = { kind: "row", completedAt: null };
    const result = await refreshAccountStatusFromStripe({ studioId: STUDIO, stripeAccountId: "acct_test" });
    expect(result.chargesEnabled).toBe(true);
    expect(h.retrieveCalls).toEqual(["acct_test"]);
    // The candidate's refresh also records the account country after sync.
    expect(h.rpcCalls.filter((c) => c.name === "sync_studio_account_status")).toHaveLength(1);
    expect(h.rpcCalls[0]).toMatchObject({ name: "sync_studio_account_status", args: {
      p_studio_id: STUDIO, p_stripe_account_id: "acct_test", p_stripe_livemode: h.livemode,
    } });
    expect(h.rpcCalls[0].args.p_onboarding_completed_at).toEqual(expect.any(String));
  });
});
