import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  parseJurisdiction,
  type StudioPaymentJurisdiction,
} from "@/lib/billing/payment-jurisdiction";

// PAY-CCY-02 (#824). The server's ONLY read of a studio's payment country and
// currency. The studio id comes from the caller's server-resolved studio
// (getCurrentPractitionerWithStudio), never from a form, and the table is
// service_role-read-only (0214), so this is the one path.
//
// A failed or unparseable read is NOT "Canada". It is unknown, and every caller
// refuses on it: defaulting would charge a US studio in CAD on a timeout.

export type JurisdictionRead =
  | { ok: true; jurisdiction: StudioPaymentJurisdiction }
  | { ok: false; reason: "read_failed" | "missing" | "invalid" };

/**
 * PAY-CCY-04. What the owner's payment settings page shows: the studio's
 * jurisdiction and, for the CURRENT deployment mode only, whether a Stripe
 * account is bound and the country Stripe reported for it. Two columns of
 * studio_payment_settings, which has no browser-role policy, hence this read.
 * No Stripe identifier leaves this function.
 */
export type StudioPaymentCountryStatus = {
  jurisdiction: JurisdictionRead;
  account:
    | { kind: "none" }
    | { kind: "bound"; observedCountry: string | null }
    | { kind: "unknown" };
};

export async function getStudioPaymentCountryStatus(
  studioId: string,
  livemode: boolean,
): Promise<StudioPaymentCountryStatus> {
  const jurisdiction = await getStudioPaymentJurisdiction(studioId);
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studio_payment_settings")
    .select("stripe_account_id, stripe_account_country")
    .eq("studio_id", studioId)
    .eq("stripe_livemode", livemode)
    .maybeSingle();
  if (error) return { jurisdiction, account: { kind: "unknown" } };
  if (!data?.stripe_account_id) return { jurisdiction, account: { kind: "none" } };
  return {
    jurisdiction,
    account: {
      kind: "bound",
      observedCountry: (data.stripe_account_country as string | null) ?? null,
    },
  };
}

export async function getStudioPaymentJurisdiction(
  studioId: string,
): Promise<JurisdictionRead> {
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("studio_payment_jurisdictions")
    .select("payment_country, payment_currency")
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) return { ok: false, reason: "read_failed" };
  if (!data) return { ok: false, reason: "missing" };
  const jurisdiction = parseJurisdiction(data);
  if (!jurisdiction) return { ok: false, reason: "invalid" };
  return { ok: true, jurisdiction };
}
