import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";

export const dynamic = "force-dynamic";

// Deletes signup attempts that never became a paid studio, 30 days after their last activity.
// Paid studios, Stripe-linked rows and any invoice or notice row are kept by the database function.
export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return new Response(null, { status: 401 });
  if (!isSelfServeCheckoutEnabled(process.env)) return new Response(null, { status: 404 });
  const { error } = await createAdminClient().rpc("purge_abandoned_hone_signups", { p_days: 30 });
  return new Response(null, { status: error ? 503 : 204 });
}
