import {
  parsePlanKey,
  PLANS,
  resolvePlanPriceId,
  type SubscriptionEnv,
} from "./plans";
import { isUserId, decideBillingEvent } from "./webhook";
import type { BillingStripeClient, createBillingStripeClient } from "./billing-client";

type Client = ReturnType<typeof createBillingStripeClient>;
export type PaidInvoiceCommand = {
  p_event: string;
  p_attempt: string;
  p_user: string;
  p_plan: string;
  p_customer: string;
  p_subscription: string;
  p_invoice: string;
  p_kind: "initial_paid" | "renewal_failed" | "renewal_paid";
  p_event_at: string;
};

// Only a collected invoice can start a studio. Subscription-created, trial,
// a redirect, or an invoice marked paid manually cannot establish payment.
export async function acceptBillingInvoice(
  raw: string,
  signature: string,
  client: Pick<BillingStripeClient, "constructEvent" | "retrieveSubscription"> &
    Pick<Client, "readInvoice">,
  env: SubscriptionEnv,
  apply: (command: PaidInvoiceCommand) => Promise<string>,
): Promise<number> {
  let event;
  try {
    event = client.constructEvent(raw, signature);
  } catch {
    return 400;
  }
  if (
    event.livemode ||
    (event.account && event.account !== env.HONE_BILLING_ACCOUNT_ID)
  )
    return 200;
  if (event.type !== "invoice.paid" && event.type !== "invoice.payment_failed")
    return 200;
  const invoiceId = event.object.id;
  if (!invoiceId) return 200;
  const invoice = await client.readInvoice(invoiceId);
  if (
    invoice.live ||
    !invoice.subscription ||
    invoice.id !== invoiceId ||
    invoice.subscription !== event.object.subscription
  )
    return 200;
  const subscription = await client.retrieveSubscription(invoice.subscription);
  const attempt = subscription.metadata.hone_attempt_id;
  const plan = parsePlanKey(subscription.metadata.hone_plan);
  if (
    !attempt ||
    !isUserId(attempt) ||
    !plan ||
    subscription.id !== invoice.subscription ||
    !invoice.customer ||
    subscription.customer !== invoice.customer ||
    invoice.price !== resolvePlanPriceId(plan, env) ||
    invoice.currency !== "usd" ||
    invoice.total !== PLANS[plan].unitAmount
  )
    return 200;
  const decision = decideBillingEvent({
    event,
    subscription,
    env,
    known: {
      eventProcessed: false,
      subscription: null,
      userStudioCreationUnlocked: false,
    },
  });
  if (decision.kind !== "apply" || subscription.items[0].price.livemode)
    return 200;
  const paid =
    invoice.status === "paid" &&
    invoice.amountPaid === invoice.total &&
    invoice.collected === invoice.total;
  let kind: PaidInvoiceCommand["p_kind"];
  if (
    invoice.reason === "subscription_create" &&
    paid &&
    ["active", "past_due", "unpaid"].includes(subscription.status)
  )
    kind = "initial_paid";
  else if (invoice.reason === "subscription_cycle" && paid)
    kind = "renewal_paid";
  else if (
    invoice.reason === "subscription_cycle" &&
    (invoice.status === "open" || invoice.status === "uncollectible") &&
    event.type === "invoice.payment_failed"
  )
    kind = "renewal_failed";
  else return 200;
  const result = await apply({
    p_event: event.id,
    p_attempt: attempt,
    p_user: decision.entitlement.userId,
    p_plan: plan,
    p_customer: invoice.customer,
    p_subscription: subscription.id,
    p_invoice: invoice.id,
    p_kind: kind,
    p_event_at: new Date(event.created * 1000).toISOString(),
  });
  return result === "retry_after_initial" ? 503 : 200;
}
