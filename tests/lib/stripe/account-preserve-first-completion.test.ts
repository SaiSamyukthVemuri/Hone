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
      return { data: null, error: h.syncErr };
    },
  }),
}));

const { refreshAccountStatusFromStripe } = await import("@/lib/stripe/account");

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
