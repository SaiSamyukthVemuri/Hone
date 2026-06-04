"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { MANUAL_FEE_AMOUNT_CEILING_CENTS } from "@/lib/billing/manual-fee-types";

// Server action for the owner-only Cancellation/no-show fee amount
// settings (PR #145). Owners enter dollar amounts; the server converts
// to cents, validates the launch range (0..20000), and writes both
// columns at once. Either field may be left blank to clear the
// configured amount (column becomes NULL; the manual-fee preview then
// blocks charge prepare for that type with "fee not configured").

export type UpdateFeeAmountsResult =
  | { ok: true }
  | { ok: false; error: string };

function parseDollarsToCentsOrNull(
  raw: FormDataEntryValue | null,
): number | null | "invalid" {
  if (raw == null) return null;
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length === 0) return null;
  // Accept whole dollars or decimals with up to two places. No
  // negative sign; the column CHECK refuses negative but we reject
  // them earlier for a clean user-facing error.
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return "invalid";
  const dollars = Number.parseFloat(s);
  if (!Number.isFinite(dollars) || dollars < 0) return "invalid";
  const cents = Math.round(dollars * 100);
  if (cents > MANUAL_FEE_AMOUNT_CEILING_CENTS) return "invalid";
  return cents;
}

export async function updateStudioFeeAmountsAction(
  formData: FormData,
): Promise<UpdateFeeAmountsResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return {
      ok: false,
      error: "Only the studio owner can change fee amounts.",
    };
  }

  const lateCancel = parseDollarsToCentsOrNull(formData.get("late_cancel_dollars"));
  const noShow = parseDollarsToCentsOrNull(formData.get("no_show_dollars"));

  if (lateCancel === "invalid" || noShow === "invalid") {
    return {
      ok: false,
      error:
        "Fee amounts must be between $0.00 and $200.00 with up to two decimals.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      late_cancel_fee_cents: lateCancel,
      no_show_fee_cents: noShow,
    })
    .eq("id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "update_studio_fee_amounts_failed",
        code: error.code,
        message: error.message,
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
    return {
      ok: false,
      error: "We couldn't save the fee amounts. Please try again.",
    };
  }
  revalidatePath("/settings/payments");
  return { ok: true };
}
