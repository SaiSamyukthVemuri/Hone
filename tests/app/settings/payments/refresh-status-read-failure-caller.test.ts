import { beforeEach, describe, expect, it, vi } from "vitest";

// PAY-READ-01 PR C remainder - CALLER SAFETY for R-32.
//
// refreshAccountStatusFromStripe() now throws when the preserve-first-completion
// read fails. It already threw for two other reasons (Stripe unreachable, sync
// RPC failed), so the throw itself is not new - but a caller that turned the new
// failure into a STATE CLAIM would be. The bar: no caller may report onboarding
// complete, onboarding incomplete, enabled, rejected, or a false success on the
// strength of a database read that failed.
//
// This drives the real server action. It also pins that no database text
// escapes: `sanitizeForUser` is an ALLOWLIST, so the new message - deliberately
// not added to it - collapses to the existing generic retryable copy. That is a
// deny-by-default property, and this test is what stops someone "helpfully"
// allowlisting the raw message later.

const h = vi.hoisted(() => ({
  refreshThrows: null as Error | null,
  refreshCalls: 0,
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "p1", role: "owner" },
    studio: { id: "11111111-1111-4111-8111-111111111111" },
  }),
}));

vi.mock("@/lib/stripe/server", () => ({
  inferStripeLivemode: () => false,
  getAppOrigin: () => "https://example.test",
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: () => {} }));

vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => ({
    from() {
      const q: Record<string, unknown> = {};
      const settle = () => ({
        data: { stripe_account_id: "acct_test" },
        error: null,
      });
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => settle();
      q.then = (resolve: (v: unknown) => unknown) => resolve(settle());
      return q;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));

vi.mock("@/lib/stripe/account", () => ({
  refreshAccountStatusFromStripe: async () => {
    h.refreshCalls += 1;
    if (h.refreshThrows) throw h.refreshThrows;
    return {
      status: "enabled",
      chargesEnabled: true,
      payoutsEnabled: true,
      onboardingCompletedAt: "2026-01-15T09:00:00.000Z",
      requirementsCurrentlyDue: [],
      requirementsEventuallyDue: [],
    };
  },
  createOrLoadStripeAccount: async () => ({ stripeAccountId: "acct_test" }),
  createAccountOnboardingLink: async () => ({ url: "https://stripe.test/x" }),
  createExpressDashboardLoginLink: async () => ({ url: "https://stripe.test/d" }),
}));

const { refreshStripeStatusAction } = await import(
  "@/app/(app)/settings/payments/actions"
);

// The exact message lib/stripe/account.ts throws on a failed preserve read.
const PRESERVE_READ_THROW = new Error(
  "Stripe status refresh could not verify local onboarding state. Try again.",
);

beforeEach(() => {
  h.refreshThrows = null;
  h.refreshCalls = 0;
});

describe("the refresh action on a failed preserve-first-completion read", () => {
  it("reports failure - never a status, never a false success", async () => {
    h.refreshThrows = PRESERVE_READ_THROW;
    const res = await refreshStripeStatusAction();
    expect(res.ok).toBe(false);
    // Critically: no snapshot is returned, so no surface can render a status
    // derived from a refresh that did not happen.
    expect("status" in res).toBe(false);
  });

  it("claims nothing about onboarding, and leaks no database text", async () => {
    h.refreshThrows = PRESERVE_READ_THROW;
    const res = await refreshStripeStatusAction();
    const message = res.ok ? "" : res.error;

    // No claim about the STUDIO's onboarding state. Note the copy legitimately
    // says "could not complete that action" - that is a statement about the
    // request, not about the studio, so matching the bare word "complete" would
    // be a false positive. The exact-equality assertion below is the real pin;
    // these are the readable statement of intent.
    expect(message).not.toMatch(/onboard/i);
    expect(message).not.toMatch(/enabled|rejected|restricted/i);
    expect(message).not.toMatch(
      /57014|statement timeout|PGRST|supabase|studio_payment_settings/i,
    );
    // The existing generic retryable copy, reached via the allowlist default.
    expect(message).toBe("Stripe could not complete that action. Please try again.");
  });

  it("the raw thrown message is NOT surfaced verbatim (allowlist holds)", async () => {
    h.refreshThrows = PRESERVE_READ_THROW;
    const res = await refreshStripeStatusAction();
    const message = res.ok ? "" : res.error;
    expect(message).not.toBe(PRESERVE_READ_THROW.message);
  });

  it("CONTROL: a successful refresh still returns the snapshot", async () => {
    // Proves the failure assertions above are caused by the throw and not by an
    // action that refuses under this harness for some unrelated reason.
    const res = await refreshStripeStatusAction();
    expect(res.ok).toBe(true);
    expect(h.refreshCalls).toBe(1);
  });
});
