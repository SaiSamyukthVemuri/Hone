import { POST as handleStripeWebhook } from "@/app/api/stripe/webhook/route";
import { runWithWebhookPlatform } from "@/lib/stripe/webhook-platform";

// HON-90. The US platform account's webhook endpoint. Stripe signs a US platform's events with that platform's own secret
// (STRIPE_WEBHOOK_SECRET_US), so it has its own URL. The handler is the SAME one the CA route runs (one implementation of the
// signature check, the idempotent claim and the event arms); only the platform it is bound to differs, and that is fixed here, by which
// route file runs -- not by anything in the request.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<Response> {
  return runWithWebhookPlatform("US", () => handleStripeWebhook(req));
}
