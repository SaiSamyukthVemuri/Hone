import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/stripe/server", () => ({ inferStripeLivemode: () => false }));

const tables: Record<string, { data: unknown; error: unknown }> = {};
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => tables[t];
      return q;
    },
  }),
}));

import { getJurisdictionSetupVerdict } from "@/lib/billing/jurisdiction-setup-status";

const set = (j: unknown, s: unknown, je: unknown = null, se: unknown = null) => {
  tables.studio_payment_jurisdictions = { data: j, error: je };
  tables.studio_payment_settings = { data: s, error: se };
};
const US = { payment_country: "US", payment_currency: "usd" };

beforeEach(() => set(null, null));

describe("Gate B status", () => {
  it("no stored pair needs owner confirmation", async () => {
    expect((await getJurisdictionSetupVerdict("s"))?.state).toBe("needs_owner_confirmation");
  });
  it("pair but no account awaits Stripe", async () => {
    set(US, null);
    expect((await getJurisdictionSetupVerdict("s"))?.state).toBe("awaiting_stripe_account");
  });
  it("account not yet observed awaits country", async () => {
    set(US, { stripe_account_id: "acct_x", stripe_account_country: null, stripe_account_country_conflict: null });
    expect((await getJurisdictionSetupVerdict("s"))?.state).toBe("awaiting_stripe_country");
  });
  it("mismatch and conflict block", async () => {
    set(US, { stripe_account_id: "acct_x", stripe_account_country: "CA", stripe_account_country_conflict: null });
    expect((await getJurisdictionSetupVerdict("s"))?.state).toBe("country_mismatch");
    set(US, { stripe_account_id: "acct_x", stripe_account_country: "US", stripe_account_country_conflict: "CA" });
    expect((await getJurisdictionSetupVerdict("s"))?.state).toBe("country_conflict");
  });
  it("match is ready", async () => {
    set(US, { stripe_account_id: "acct_x", stripe_account_country: "US", stripe_account_country_conflict: null });
    expect((await getJurisdictionSetupVerdict("s"))?.meetsNewSetupStandard).toBe(true);
  });
  it("an unreadable table is null, never ready", async () => {
    set(US, null, null, { code: "x" });
    expect(await getJurisdictionSetupVerdict("s")).toBeNull();
    set(null, null, { code: "x" });
    expect(await getJurisdictionSetupVerdict("s")).toBeNull();
  });
});
