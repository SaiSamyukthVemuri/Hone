"use server";

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
    appointmentId: typeof appointmentId === "string" ? appointmentId : "",
  });
  return { ...ctx, isOwner: practitioner.role === "owner" };
}
