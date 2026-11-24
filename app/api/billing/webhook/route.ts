import { createAdminClient } from "@/lib/supabase/admin-server";
import { createBillingStripeClient } from "@/lib/subscriptions/billing-client";
import { acceptBillingInvoice } from "@/lib/subscriptions/paid-signup";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  if (!isSelfServeCheckoutEnabled(process.env))
    return new Response(null, { status: 404 });
  if (!process.env.HONE_BILLING_WEBHOOK_SECRET)
    return new Response(null, { status: 503 });
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response(null, { status: 400 });
  try {
    const status = await acceptBillingInvoice(
      await request.text(),
      signature,
      createBillingStripeClient(process.env),
      process.env,
      async (command) => {
        const { data, error } = await createAdminClient().rpc(
          "apply_hone_billing_invoice",
          command,
        );
        if (error) throw new Error("billing_store_unavailable");
        return data;
      },
    );
    return new Response(null, { status });
  } catch {
    return new Response(null, { status: 503 });
  }
}
