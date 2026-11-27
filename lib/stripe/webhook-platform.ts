import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type Stripe from "stripe";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { PLATFORM_ENV, type StripePlatform } from "@/lib/stripe/platform-routing";
import { getStripe, getStripeFor } from "@/lib/stripe/server";

// HON-90. WHICH PLATFORM A WEBHOOK DELIVERY BELONGS TO.
//
// Each platform account signs its own events with its own endpoint secret, so each has its OWN route (the CA one is the existing
// /api/stripe/webhook, unchanged; the US one is /api/stripe/webhook-us). The platform is therefore the ROUTE the delivery arrived on,
// fixed in code by which route file runs -- never read from the request body, a header or a query. The US route runs the shared handler
// inside runWithWebhookPlatform("US"); a delivery with no context is the CA platform, exactly as before.

const store = new AsyncLocalStorage<StripePlatform>();

export function runWithWebhookPlatform<T>(platform: StripePlatform, fn: () => Promise<T>): Promise<T> {
  return store.run(platform, fn);
}

export function currentWebhookPlatform(): StripePlatform {
  return store.getStore() ?? "CA";
}

/** The signing secret of the platform this delivery arrived on. Only that platform's own variable is read. */
export function webhookSecretVariable(): string {
  return PLATFORM_ENV[currentWebhookPlatform()].webhookSecret;
}

/** The Stripe client of the platform this delivery arrived on (CA: the existing getStripe()). */
export function webhookStripe(): Stripe {
  if (currentWebhookPlatform() === "US") {
    const stripe = getStripeFor("US");
    return stripe;
  }
  const stripe = getStripe();
  return stripe;
}

/**
 * On the US route only: true when the studio bound to the event's connected account is NOT a US studio (its own jurisdiction row is
 * absent or says another country). Such an event is treated as an unbound account, never applied to a studio of the wrong platform.
 * The CA route does no such read: its behaviour is unchanged.
 */
export async function usWebhookStudioMismatch(studioId: string): Promise<boolean> {
  if (currentWebhookPlatform() !== "US") return false;
  const read = await getStudioPaymentJurisdiction(studioId);
  return !(read.ok && read.jurisdiction.country === "US");
}
