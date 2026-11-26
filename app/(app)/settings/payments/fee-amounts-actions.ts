"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { MANUAL_FEE_AMOUNT_CEILING_CENTS } from "@/lib/billing/manual-fee-types";
import { fixedFeeCentsIssue } from "@/lib/billing/manual-fee-percent";
import { dbErrorCode } from "@/lib/logging/error-class";

// Server action for the owner-only Cancellation/no-show fee amount
// settings (PR #145). Owners enter dollar amounts; the server converts
// to cents, validates the launch range (0..20000), and writes both
// columns at once. Either field may be left blank to clear the
// configured amount (column becomes NULL; the manual-fee preview then
// blocks charge prepare for that type with "fee not configured").
//
// This action writes ONLY the two amount columns. It never changes a fee's
// on/off switch, mode or percentage: those have their own actions in
// fee-settings-actions.ts (one per setting, compare-and-set), so a stale tab
// saving an amount cannot flip a switch back.

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
  // A fixed-mode fee that is ON must keep a usable amount: refuse to blank it (turn the fee off first).
  const { data: current } = await supabase
    .from("studios")
    .select("late_cancel_fee_enabled, no_show_fee_enabled, late_cancel_fee_mode, no_show_fee_mode")
    .eq("id", studio.id)
    .maybeSingle();
  if (!current) return { ok: false, error: "We couldn't save the fee amounts. Please try again." };
  if (current.late_cancel_fee_enabled === true && current.late_cancel_fee_mode === "fixed" && fixedFeeCentsIssue(lateCancel) !== null) {
    return { ok: false, error: "Turn late cancellation fees off before clearing or zeroing the amount." };
  }
  if (current.no_show_fee_enabled === true && current.no_show_fee_mode === "fixed" && fixedFeeCentsIssue(noShow) !== null) {
    return { ok: false, error: "Turn no-show fees off before clearing or zeroing the amount." };
  }
  // Compare-and-set: the validity check above read these four values. If another tab changed any of them since (for
  // example turned a fee ON), this write must not land, or it could leave an ON fixed fee with no amount. Zero rows
  // matched means "changed elsewhere": nothing is written and the owner is told to refresh.
  const guards: Array<[string, boolean | string | null]> = [
    ["late_cancel_fee_enabled", current.late_cancel_fee_enabled ?? null],
    ["no_show_fee_enabled", current.no_show_fee_enabled ?? null],
    ["late_cancel_fee_mode", current.late_cancel_fee_mode ?? null],
    ["no_show_fee_mode", current.no_show_fee_mode ?? null],
  ];
  let write = supabase
    .from("studios")
    .update({
      late_cancel_fee_cents: lateCancel,
      no_show_fee_cents: noShow,
    })
    .eq("id", studio.id);
  for (const [column, value] of guards) write = value === null ? write.is(column, null) : write.eq(column, value);
  const { data: written, error } = await write.select("id");
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
  if (!written || written.length === 0) {
    return {
      ok: false,
      error: "This setting was changed somewhere else. Refresh the page to see the current value, then try again.",
    };
  }
  revalidatePath("/settings/payments", "layout");
  return { ok: true };
}
