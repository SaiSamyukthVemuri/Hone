import "server-only";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { validateProposal } from "@/lib/billing/jurisdiction-setup";

// JURISDICTION-ONBOARDING PR-2 (Gate A). The owner's explicit confirmation of
// country and currency. The audit table keeps the history. Default-off (G4): when the switch is not
// "true" nothing here calls the database.
//
// Never inferred from timezone, IP or locale. Saved through the INITIALIZE-ONLY
// command (0270): it cannot update a stored pair, so two concurrent
// confirmations cannot overwrite each other. A different stored pair comes back
// as `already_set` and is reported, not changed. This module adds no writer
// beyond that one command.

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
const ALREADY_SET =
  "This studio's country and currency were already confirmed with different details. Check the payments page, or contact Hone support to change them.";
const CHANGED =
  "This studio's country and currency were changed by another request. Check the payments page, or contact Hone support.";
const PRICED =
  "This studio already has prices set up, so its country and currency cannot be set here. Contact Hone support to confirm them.";

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

  const stamp = (input.now ?? new Date()).toISOString();
  const { data, error } = await createAdminClient().rpc("initialize_studio_payment_jurisdiction_owner", {
    p_studio_id: input.studioId,
    p_payment_country: country,
    p_payment_currency: currency,
    p_actor: `owner:${input.practitionerId}`,
    p_reason: "owner onboarding confirmation",
    p_verification_reference: `owner-confirmed:${input.practitionerId}:${stamp}:${country}/${currency}`,
  });
  if (error) return { ok: false, error: GENERIC };
  const row = Array.isArray(data) ? data[0] : data;
  const result = row && typeof row === "object" ? (row as { out_result?: unknown }).out_result : null;
  if (result === "initialized") return { ok: true, outcome: "confirmed" };
  if (result === "unchanged") return { ok: true, outcome: "already_confirmed" };
  if (result === "already_set") return { ok: false, error: ALREADY_SET };
  // The initialize-only command never returns this. If it ever does, a stored
  // pair WAS replaced, so say so instead of claiming nothing happened.
  if (result === "changed") return { ok: false, error: CHANGED };
  if (result === "refused_priced_configuration") return { ok: false, error: PRICED };
  if (typeof result === "string" && result.startsWith("refused_")) return { ok: false, error: CONTACT };
  return { ok: false, error: GENERIC };
}
