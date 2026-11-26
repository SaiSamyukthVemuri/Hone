"use server";

import { resolveAppointmentQuotedAmountCents } from "@/lib/billing/appointment-settlement";
import { getStudioPaymentJurisdiction } from "@/lib/billing/payment-jurisdiction-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  resolveQuickCheckoutContext,
  type QuickCheckoutContext,
} from "@/lib/billing/quick-checkout";

// Server action that resolves quick-checkout context for an appointment. The
// authenticated practitioner + studio are derived SERVER-SIDE
// (getCurrentPractitionerWithStudio redirects unauthenticated / inactive
// callers), so no client-supplied studio/role/amount/status is trusted and a
// cross-studio appointment id resolves to "not found in this studio". This
// action only READS (via resolveQuickCheckoutContext). It never charges,
// writes, or touches clinical state; the charge itself still runs through the
// existing hardened prepare/execute/receipt/refund actions.

export type QuickCheckoutContextResult = QuickCheckoutContext & {
  isOwner: boolean;
};

export async function getQuickCheckoutContextAction(
  appointmentId: string,
): Promise<QuickCheckoutContextResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  // HON-44 (Sam decision 12): checkout money context (service price, settled and
  // quoted amounts, card state) is owner-only. A non-owner gets a closed refusal
  // and no resolver call is made, so no money is read for them at all.
  if (practitioner.role !== "owner") {
    return {
      ok: false,
      reason: "Only the studio owner can take payment.",
      clientId: null,
      settlement: null,
      isOwner: false,
    };
  }
  const ctx = await resolveQuickCheckoutContext({
    studioId: studio.id,
    studioTimezone: studio.timezone,
    viewerIsOwner: practitioner.role === "owner",
    appointmentId: typeof appointmentId === "string" ? appointmentId : "",
  });
  return { ...ctx, isOwner: practitioner.role === "owner" };
}

/** A draft fee can be reviewed before completion. Only the signed-in owner
 * sees the client-specific price, and payment confirmation rechecks it. */
export async function getDashboardCheckoutQuoteAction(appointmentId: string) {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") return null;
  const viewerIsOwner = practitioner.role === "owner";
  const [referenceCents, jurisdiction] = await Promise.all([
    resolveAppointmentQuotedAmountCents(studio.id, appointmentId, studio.timezone, viewerIsOwner),
    getStudioPaymentJurisdiction(studio.id),
  ]);
  return referenceCents === null ? null : {
    referenceCents,
    currency: jurisdiction.ok ? jurisdiction.jurisdiction.currency : null,
  };
}
