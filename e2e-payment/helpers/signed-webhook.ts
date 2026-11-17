import Stripe from "stripe";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";

// Sends a REALLY-SIGNED provider event to the running app's webhook route, the way the provider would, with the harness's fake signing
// secret (the same value the Next server is started with). No network beyond the local app; no real Stripe key or account is involved.
const SECRET = E2E_WEB_SERVER_ENV.STRIPE_WEBHOOK_SECRET;

export async function postSignedStripeEvent(event: Record<string, unknown>): Promise<Response> {
  const payload = JSON.stringify(event);
  const header = new Stripe("sk_test_synthetic_no_network").webhooks.generateTestHeaderString({ payload, secret: SECRET });
  return fetch(`${E2E_APP_ORIGIN}/api/stripe/webhook`, {
    method: "POST",
    headers: { "content-type": "application/json", "stripe-signature": header },
    body: payload,
  });
}
