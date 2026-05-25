// Stripe's `refresh_url` lands here when the onboarding link expires
// or the practitioner backs out. We re-mint a fresh AccountLink and
// redirect to it.

import { redirect } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  createConnectOnboardingLink,
  createOrLoadConnectedAccountForStudio,
} from "@/lib/stripe/account";
import { getAppOrigin } from "@/lib/stripe/server";

export const dynamic = "force-dynamic";

export default async function StripeOnboardingRefreshPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    redirect("/settings/payments");
  }

  try {
    const { stripeAccountId } = await createOrLoadConnectedAccountForStudio(
      studio.id,
    );
    const url = await createConnectOnboardingLink({
      stripeAccountId,
      appOrigin: getAppOrigin(),
    });
    redirect(url);
  } catch (err) {
    // If something is wrong, fall back to the payments page rather
    // than throwing a server error at the practitioner. The payments
    // page itself surfaces the current Stripe state and a Refresh
    // status button.
    if (typeof err === "object" && err !== null && "digest" in err) {
      // NEXT_REDIRECT — let it propagate.
      throw err;
    }
    console.error(
      JSON.stringify({
        event: "stripe_refresh_page_failed",
        err: err instanceof Error ? err.message : String(err),
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
    redirect("/settings/payments");
  }
}
