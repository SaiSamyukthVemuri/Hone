import "server-only";
import type Stripe from "stripe";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { getStripe, getStripeFor } from "@/lib/stripe/server";
import { routeStripePlatform, type PlatformRefusal, type StripePlatform } from "@/lib/stripe/platform-routing";

// HON-90. The ONE way server code gets a Stripe client for a STUDIO. The platform is resolved from the studio's own verified payment
// jurisdiction row (0214), read on the server by studio id -- never from the request, a form field, a header, or a connected-account id.
// A studio with no verified row, or whose platform is not configured for this deployment, gets a refusal, never the Canadian client:
// the charge path already refuses an unverified studio, and every other studio path now does the same.
//
// CA studios resolve to getStripe(), the existing client, unchanged. US studios resolve to getStripeFor("US").

export type StudioPlatformRefusal = PlatformRefusal | "read_failed" | "missing" | "invalid";

export type StudioPlatform = { ok: true; platform: StripePlatform } | { ok: false; reason: StudioPlatformRefusal };

export async function resolveStudioPlatform(
  studioId: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<StudioPlatform> {
  const read = await getStudioPaymentJurisdiction(studioId);
  if (!read.ok) return { ok: false, reason: read.reason };
  return routeStripePlatform({ country: read.jurisdiction.country, currency: read.jurisdiction.currency }, env);
}

export class StripePlatformUnavailableError extends Error {
  constructor(readonly reason: StudioPlatformRefusal) {
    super("Payments are not available for this studio's payment country yet.");
    this.name = "StripePlatformUnavailableError";
  }
}

/** The Stripe client of the platform that owns this studio's connected account. Throws StripePlatformUnavailableError on a refusal. */
export async function requireStripeForStudio(studioId: string): Promise<Stripe> {
  const route = await resolveStudioPlatform(studioId);
  if (!route.ok) throw new StripePlatformUnavailableError(route.reason);
  if (route.platform === "CA") {
    const stripe = getStripe();
    return stripe;
  }
  const stripe = getStripeFor("US");
  return stripe;
}
