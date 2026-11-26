import { isAuthorizedCronRequest } from "@/lib/cron/auth";
import { isSelfServeCheckoutEnabled } from "@/lib/subscriptions/plans";
import { processSubscriptionChange } from "@/lib/subscriptions/subscription-change";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAuthorizedCronRequest(request)) return new Response(null, { status: 401 });
  if (!isSelfServeCheckoutEnabled(process.env)) return new Response(null, { status: 404 });
  try {
    for (let n = 0; n < 20; n++) {
      if (await processSubscriptionChange(null) === "idle") break;
    }
    return new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 503 });
  }
}
