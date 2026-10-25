// PAYMENT-WEBHOOK-MAINTENANCE-FLAG. A default-OFF switch for the #1035 S1->S3
// cutover window (Privacy PEER-COMPAT-0239-0245, option b).
//
// WHY IT EXISTS. 0239/0240 close the success reconciler and add refund
// provenance, but B-OLD's payment_intent.payment_failed and charge.refunded
// arms are DIRECT service-role UPDATEs that no migration revokes. Between the
// apply and the B-1035 deploy they would keep writing without 0240's bound
// identity or provenance. With the switch ON, those two events are deferred:
// the webhook answers 500 and releases its claim before any handler runs, so
// Stripe redelivers them and B-1035 processes them.
//
// OFF IS TODAY. Unset, empty or any value other than the exact string "1" is
// OFF, and the webhook behaves exactly as before this file existed. Read on
// every request (never cached at module load), server-side only: there is no
// NEXT_PUBLIC_ form and nothing a request can supply turns it on.
//
// NOT GATED, deliberately: payment_intent.succeeded and setup_intent.succeeded
// (0239/0245 already make them 500 under B-OLD), and charge.dispute.created
// (alert-only, it writes no money).
//
// Setting it in production is an operator action under Sam's authority, for
// the S1->S3 window only. Remove this file once #1035 is deployed.

export const PAYMENT_WEBHOOK_MAINTENANCE_ENV = "HONE_PAYMENT_WEBHOOK_MAINTENANCE";

export function paymentWebhookMaintenanceOn(): boolean {
  return process.env[PAYMENT_WEBHOOK_MAINTENANCE_ENV] === "1";
}

/**
 * Thrown inside the dispatch, after the claim, so the route's existing catch
 * releases the claim and answers 500. It is an expected deferral, not a
 * failure: the route logs it structurally and raises no critical alert.
 */
export class PaymentWebhookMaintenanceDeferral extends Error {
  constructor(readonly eventType: string) {
    super(`payment_webhook_maintenance_deferred:${eventType}`);
    this.name = "PaymentWebhookMaintenanceDeferral";
  }
}
