import { getRequiredAppOrigin } from "@/lib/app-origin";
import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { FROM_ADDRESS, getResendTransport } from "@/lib/email/client";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import {
  deliverSubscriptionNotice,
  type Notice,
} from "@/lib/subscriptions/notice-email";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!isAuthorizedCronRequest(req)) return new Response(null, { status: 401 });
  // This billing draft runs in a Stripe sandbox. Deliver only to the verified
  // owner whose address matches the private acceptance inbox configured here.
  const recipient = process.env.HONE_BILLING_TEST_RECIPIENT?.trim();
  if (!isSelfServeCheckoutEnabled(process.env) || !recipient)
    return Response.json({ enabled: false });
  let accepted = 0;
  let failures = 0;
  try {
    const stripe = createBillingStripeClient(process.env);
    const db = createAdminClient();
    const transport = getResendTransport();
    if (!transport) throw new Error("Mail unavailable");
    const billingUrl = getRequiredAppOrigin() + "/settings/subscription";
    for (let count = 0; count < 20; count++) {
      const { data, error } = await db.rpc("claim_hone_subscription_notice", {
        p_recipient: recipient,
      });
      if (error) throw new Error("Claim failed");
      if (!data) break;
      if (data.needs_review) throw new Error("Previous email delivery requires reconciliation");
      const notice: Notice = data;
      const lease = { p_id: notice.id, p_lease: notice.lease };
      try {
        const sent = await deliverSubscriptionNotice(notice, {
          readInvoice: stripe.readNoticeInvoice,
          env: process.env,
          billingUrl,
          from: FROM_ADDRESS,
          async authorize(hash) {
            const result = await db.rpc("authorize_hone_subscription_notice", {
              ...lease,
              p_recipient: notice.recipient,
              p_hash: hash,
              p_deadline: notice.deadline,
            });
            if (result.error) throw new Error("Authorization failed");
            return result.data === true;
          },
          send: (payload, key) =>
            transport.emails.send(payload, { idempotencyKey: key }),
          async finish() {
            const result = await db.rpc(
              "finish_hone_subscription_notice",
              lease,
            );
            return !result.error && result.data === true;
          },
        });
        if (sent === "accepted") accepted++;
      } catch {
        failures++;
      }
    }
  } catch {
    failures++;
  }
  return Response.json(
    { accepted, failures },
    { status: failures ? 503 : 200 },
  );
}
