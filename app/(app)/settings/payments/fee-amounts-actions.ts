"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { MANUAL_FEE_AMOUNT_CEILING_CENTS } from "@/lib/billing/manual-fee-types";
import { dbErrorCode } from "@/lib/logging/error-class";

// Server action for the owner-only Cancellation/no-show fee amount
// settings (PR #145). Owners enter dollar amounts; the server converts
// to cents, validates the launch range (0..20000), and writes both
// columns at once. Either field may be left blank to clear the
// configured amount (column becomes NULL; the manual-fee preview then
// blocks charge prepare for that type with "fee not configured").
//
// It also writes the two per-studio manual-fee switches (migration 0351,
// default OFF). A switch can be turned ON only with an amount above zero,
// the same rule the charge eligibility applies (NULL and 0 are "not
// configured"), so the owner is told here instead of at charge time. The
// server is the authority: the page's checkboxes are presentation only.

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

  const lateEnabled = formData.get("late_cancel_enabled") === "true";
  const noShowEnabled = formData.get("no_show_enabled") === "true";
  if (lateEnabled && (lateCancel == null || lateCancel === 0)) {
    return {
      ok: false,
      error:
        "Enter a late cancellation fee amount above $0.00 before turning late cancellation fees on.",
    };
  }
  if (noShowEnabled && (noShow == null || noShow === 0)) {
    return {
      ok: false,
      error:
        "Enter a no-show fee amount above $0.00 before turning no-show fees on.",
    };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      late_cancel_fee_cents: lateCancel,
      no_show_fee_cents: noShow,
      late_cancel_fee_enabled: lateEnabled,
      no_show_fee_enabled: noShowEnabled,
    })
    .eq("id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "update_studio_fee_amounts_failed",
        code: dbErrorCode(error),
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
    return {
      ok: false,
      error: "We couldn't save the fee amounts. Please try again.",
    };
  }
  revalidatePath("/settings/payments", "layout");
  return { ok: true };
}
