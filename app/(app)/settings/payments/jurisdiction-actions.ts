"use server";

import { revalidatePath } from "next/cache";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import {
  confirmStudioJurisdictionAsOwner,
  type OwnerConfirmationResult,
} from "@/lib/billing/jurisdiction-owner-confirmation";

// Owner-only. The studio and practitioner are resolved server-side; the form
// supplies only the two values and the confirmation tick.
export async function confirmStudioJurisdictionAction(
  formData: FormData,
): Promise<OwnerConfirmationResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return { ok: false, error: "Only the studio owner can confirm the business country." };
  }
  const result = await confirmStudioJurisdictionAsOwner({
    studioId: studio.id,
    practitionerId: practitioner.id,
    country: formData.get("country"),
    currency: formData.get("currency"),
    confirmed: formData.get("confirm") === "yes",
  });
  if (result.ok) revalidatePath("/settings/payments");
  return result;
}
