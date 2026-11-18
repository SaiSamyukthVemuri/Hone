import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #159. Portal layout cleanup. What stays pinned here: the portal page
// moves no money and never imports the Supabase admin client.

const PORTAL_PATH = path.resolve(
  __dirname,
  "../../../app/portal/page.tsx",
);
const SOURCE = readFileSync(PORTAL_PATH, "utf8");

// ---------------------------------------------------------------------------
// No payment / Stripe behavior added by this PR. Mirror of the
// Stripe gates at the unit level so a copy refactor cannot smuggle
// a dangerous call through.
// ---------------------------------------------------------------------------

describe("no payment behavior added", () => {
  it("portal page does not call PaymentIntent / Charge / Refund / Checkout / live-mode", () => {
    expect(SOURCE).not.toMatch(/paymentIntents\.create/);
    expect(SOURCE).not.toMatch(/charges\.create/);
    expect(SOURCE).not.toMatch(/refunds\.create/);
    expect(SOURCE).not.toMatch(/checkout\.sessions/);
    expect(SOURCE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE=true/);
  });

  it("portal page does not import the Supabase admin client", () => {
    expect(SOURCE).not.toMatch(/admin-server|createAdminClient/);
  });
});
