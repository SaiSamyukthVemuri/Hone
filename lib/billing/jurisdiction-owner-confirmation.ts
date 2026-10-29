import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { validateProposal } from "@/lib/billing/jurisdiction-setup";

// JURISDICTION-ONBOARDING PR-2 (Gate A). The owner's explicit confirmation of
// country and currency, saved through the existing 0214 command. This module
// adds no writer: set_studio_payment_jurisdiction stays the only one, and its
// audit table keeps the history. Default-off (G4): when the switch is not
// "true" nothing here calls the database.
//
// Never inferred from timezone, IP or locale. Never overwrites: an existing
// row that differs from the proposal is reported, not changed.

export const OWNER_CONFIRMATION_ENV = "OWNER_JURISDICTION_CONFIRMATION_ENABLED";

export function ownerJurisdictionConfirmationEnabled(): boolean {
  return process.env[OWNER_CONFIRMATION_ENV] === "true";
}

export type OwnerConfirmationResult =
  | { ok: true; outcome: "confirmed" | "already_confirmed" }
  | { ok: false; error: string };

const UNAVAILABLE = "Confirming your business country is not available yet.";
const GENERIC = "Hone could not save that. Nothing was changed. Please try again.";
const CONTACT =
  "This studio already has payment history or a Stripe account that this cannot change. Contact Hone support to correct it.";

export async function confirmStudioJurisdictionAsOwner(input: {
  studioId: string;
  practitionerId: string;
  country: unknown;
  currency: unknown;
  confirmed: boolean;
  now?: Date;
}): Promise<OwnerConfirmationResult> {
  if (!ownerJurisdictionConfirmationEnabled()) return { ok: false, error: UNAVAILABLE };

  const proposal = validateProposal({ country: input.country, currency: input.currency });
  if (!proposal.ok) {
    return {
      ok: false,
      error:
        proposal.reason === "unsupported_combination"
          ? "Hone supports Canada with CAD and the United States with USD."
          : "Choose both your business country and your currency.",
    };
  }
  if (!input.confirmed) {
    return { ok: false, error: "Tick the box to confirm these details before saving." };
  }
  const { country, currency } = proposal.jurisdiction;

  // Never silently overwrite: a stored pair is reported, not replaced.
  const existing = await getStudioPaymentJurisdiction(input.studioId);
  if (existing.ok) {
    if (existing.jurisdiction.country === country && existing.jurisdiction.currency === currency) {
      return { ok: true, outcome: "already_confirmed" };
    }
    return { ok: false, error: CONTACT };
  }
  if (existing.reason !== "missing") return { ok: false, error: GENERIC };

  const stamp = (input.now ?? new Date()).toISOString();
  const { data, error } = await createAdminClient().rpc("set_studio_payment_jurisdiction", {
    p_studio_id: input.studioId,
    p_payment_country: country,
    p_payment_currency: currency,
    p_actor: `owner:${input.practitionerId}`,
    p_reason: "owner onboarding confirmation",
    p_acknowledge_configured_prices: false,
    p_verification_reference: `owner-confirmed:${input.practitionerId}:${stamp}:${country}/${currency}`,
  });
  if (error) return { ok: false, error: GENERIC };
  const row = Array.isArray(data) ? data[0] : data;
  const result = row && typeof row === "object" ? (row as { out_result?: unknown }).out_result : null;
  if (result === "initialized") return { ok: true, outcome: "confirmed" };
  if (result === "unchanged") return { ok: true, outcome: "already_confirmed" };
  if (typeof result === "string" && result.startsWith("refused_")) return { ok: false, error: CONTACT };
  return { ok: false, error: GENERIC };
}
