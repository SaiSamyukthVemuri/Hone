// Stripe's `return_url` lands here after the practitioner finishes
// (or abandons) the onboarding flow. We do NOT trust the URL itself
// as proof of onboarding completion — Stripe just redirects whoever
// pressed "Continue". Instead we re-pull the account status from
// Stripe and reflect the freshly synced state.

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { refreshAccountStatusFromStripe } from "@/lib/stripe/account";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { createAdminClient } from "@/lib/supabase/admin-server";

export const dynamic = "force-dynamic";

export default async function StripeOnboardingReturnPage() {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    redirect("/settings/payments");
  }

  const admin = createAdminClient();
  // Mode-scoped (0103): a studio can hold one settings row per Stripe mode;
  // this return page must sync the CURRENT deployment mode's account only.
  const { data: settings } = await admin
    .from("studio_payment_settings")
    .select("stripe_account_id")
    .eq("studio_id", studio.id)
    .eq("stripe_livemode", inferStripeLivemode())
    .maybeSingle();

  // Best-effort sync. We do NOT fail the page if Stripe is briefly
  // unreachable; the owner can press "Refresh Stripe status" on the
  // settings page to retry.
  if (settings?.stripe_account_id) {
    try {
      await refreshAccountStatusFromStripe({
        studioId: studio.id,
        stripeAccountId: settings.stripe_account_id,
      });
    } catch (err) {
      console.error(
        JSON.stringify({
          event: "stripe_return_sync_failed",
          err: err instanceof Error ? err.message : String(err),
          studioId: studio.id,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  }

  return (
    <main className="flex flex-col gap-4 p-6">
      <h1 className="text-2xl font-semibold tracking-tight">
        Stripe onboarding update
      </h1>
      <p className="text-sm text-neutral-500">
        Thanks. We&rsquo;ve refreshed your Stripe account status. Open the
        payments page to see the latest state.
      </p>
      <div>
        <Link
          href="/settings/payments"
          className="rounded-md border border-neutral-900 bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-800 dark:border-white dark:bg-white dark:text-neutral-950"
        >
          Back to payments
        </Link>
      </div>
    </main>
  );
}
