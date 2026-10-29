import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { inferStripeLivemode } from "@/lib/stripe/server";
import { evaluateSetup, type SetupVerdict } from "@/lib/billing/jurisdiction-setup";

// JURISDICTION-ONBOARDING PR-3 (Gate B). Reads the three stored facts for the
// CURRENT deployment mode and hands them to the pure evaluator. Read-only:
// it writes nothing and enables nothing. Default-off (G4): the status panel is
// shown only while OWNER_JURISDICTION_CONFIRMATION_ENABLED is "true".
// A failed read is never "ready": it is reported as unconfirmed.
//
// Price currencies are not read here: no money-row/price currency source is
// wired into this panel, so "ready" speaks only to entered vs Stripe-observed.
// The database guard on payment_charge_attempts remains the authority.

export async function getJurisdictionSetupVerdict(studioId: string): Promise<SetupVerdict | null> {
  const admin = createAdminClient();
  const [j, s] = await Promise.all([
    admin
      .from("studio_payment_jurisdictions")
      .select("payment_country, payment_currency")
      .eq("studio_id", studioId)
      .maybeSingle(),
    admin
      .from("studio_payment_settings")
      .select("stripe_account_id, stripe_account_country, stripe_account_country_conflict")
      .eq("studio_id", studioId)
      .eq("stripe_livemode", inferStripeLivemode())
      .maybeSingle(),
  ]);
  if (j.error || s.error) return null;
  return evaluateSetup({
    entered: j.data ?? null,
    hasConnectedAccount: !!s.data?.stripe_account_id,
    observedAccountCountry: (s.data?.stripe_account_country as string | null) ?? null,
    conflictingAccountCountry: (s.data?.stripe_account_country_conflict as string | null) ?? null,
    statedCurrencies: [],
  });
}
