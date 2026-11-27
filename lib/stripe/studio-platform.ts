import "server-only";
import type Stripe from "stripe";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { getStripe, getStripeFor } from "@/lib/stripe/server";
import { routeStripePlatform, type PlatformRefusal, type StripePlatform } from "@/lib/stripe/platform-routing";

// HON-90. The ONE way server code gets a Stripe client for a STUDIO. The platform is resolved from the studio's own verified payment
// jurisdiction row (0214), read on the server by studio id -- never from the request, a form field, a header, or a connected-account id.
//
// TWO PURPOSES, because production holds studios whose connected account PREDATES jurisdiction rows (every pre-#824 account was created in
// Canada, and 0214 deliberately left such studios without a row until an operator verifies one):
//
//   * "new_money"       creating money or an account: a charge, a new connected account. REQUIRES a verified row. No row, no client.
//   * "existing_account" reading or servicing an account that ALREADY exists: status refresh, onboarding resume, dashboard link, card-on-file,
//                        and acting on an existing payment (refund, reconcile, cancel). A studio with NO row but an existing connected
//                        account keeps resolving to the CA platform, as it always has; that is the only case where an absent row means CA.
//
// A US platform is chosen ONLY by an explicit US row, under either purpose: never by default, never from a missing row. A row that is
// present but unreadable or invalid refuses under both. CA studios resolve to getStripe(), the existing client, unchanged.

export type PlatformPurpose = "new_money" | "existing_account";

export type StudioPlatformRefusal = PlatformRefusal | "read_failed" | "missing" | "invalid";

export type StudioPlatform = { ok: true; platform: StripePlatform } | { ok: false; reason: StudioPlatformRefusal };

/** Whether the studio has a connected account in ANY mode (a test and a live account are two rows of one studio). */
async function studioHasConnectedAccount(studioId: string): Promise<boolean | "read_failed"> {
  try {
    const admin = createAdminClient();
    const { data, error } = await admin
      .from("studio_payment_settings")
      .select("stripe_account_id")
      .eq("studio_id", studioId)
      .not("stripe_account_id", "is", null)
      .limit(1);
    if (error) return "read_failed";
    return Array.isArray(data) && data.length > 0;
  } catch {
    return "read_failed";
  }
}

export async function resolveStudioPlatform(
  studioId: string,
  purpose: PlatformPurpose,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StudioPlatform> {
  const read = await getStudioPaymentJurisdiction(studioId);
  if (read.ok) return routeStripePlatform({ country: read.jurisdiction.country, currency: read.jurisdiction.currency }, env);
  if (read.reason === "missing" && purpose === "existing_account") {
    const has = await studioHasConnectedAccount(studioId);
    if (has === true) return { ok: true, platform: "CA" };
    if (has === "read_failed") return { ok: false, reason: "read_failed" };
  }
  return { ok: false, reason: read.reason };
}

export class StripePlatformUnavailableError extends Error {
  constructor(readonly reason: StudioPlatformRefusal) {
    super("Payments are not available for this studio's payment country yet.");
    this.name = "StripePlatformUnavailableError";
  }
}

/** The Stripe client of the platform that owns this studio's connected account. Throws StripePlatformUnavailableError on a refusal. */
export async function requireStripeForStudio(studioId: string, purpose: PlatformPurpose): Promise<Stripe> {
  const route = await resolveStudioPlatform(studioId, purpose);
  if (!route.ok) throw new StripePlatformUnavailableError(route.reason);
  if (route.platform === "CA") {
    const stripe = getStripe();
    return stripe;
  }
  const stripe = getStripeFor("US");
  return stripe;
}
