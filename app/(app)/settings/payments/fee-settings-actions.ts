"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { manualFeeConfigIssue, parsePercentTextToBp, isValidPercentBp } from "@/lib/billing/manual-fee-percent";
import { dbErrorCode } from "@/lib/logging/error-class";

// Owner-only manual-fee settings, ONE server action per setting (migration 0351). Each action writes exactly one column and is
// a COMPARE-AND-SET against the value the page loaded: the UPDATE carries `where <column> = <value the owner saw>`, so a tab
// that went stale cannot silently overwrite a newer choice (a stale tab can no longer flip a fee back ON, or switch its
// mode). Zero rows updated means "changed elsewhere": the owner is told to refresh, and nothing was written.
//
// None of these actions can charge anyone, and none changes an amount: the fixed amount is saved by
// updateStudioFeeAmountsAction, which writes only the two amount columns.
//
// WHO. getCurrentPractitionerWithStudio gives the practitioner and studio from the session; role must be owner. The write
// uses the owner's own session (RLS policy "studios: owners update", 0001), not the service role. Every change is recorded by
// the studios_manual_fee_setting_audit trigger (0351), so a change made any other way is recorded too.

export type FeeSettingResult = { ok: true } | { ok: false; error: string };
export type FeeType = "late_cancel" | "no_show";

const OWNER_ONLY = "Only the studio owner can change fee settings.";
const STALE = "This setting was changed somewhere else. Refresh the page to see the current value, then try again.";
const SAVE_FAILED = "We couldn't save that setting. Please try again.";

function col(type: FeeType, what: "enabled" | "mode" | "percent_bp" | "cents"): string {
  return `${type === "late_cancel" ? "late_cancel" : "no_show"}_fee_${what}`;
}
function reason(type: FeeType): "late_cancellation_fee" | "no_show_fee" {
  return type === "late_cancel" ? "late_cancellation_fee" : "no_show_fee";
}
function isFeeType(v: unknown): v is FeeType {
  return v === "late_cancel" || v === "no_show";
}
const NAME = { late_cancel: "late cancellation", no_show: "no-show" } as const;

async function owner() {
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    if (practitioner.role !== "owner") return null;
    return studio.id;
  } catch {
    return null;
  }
}

type Row = Record<string, unknown>;

async function loadRow(studioId: string): Promise<Row | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("studios")
    .select(
      "late_cancel_fee_cents, no_show_fee_cents, late_cancel_fee_enabled, no_show_fee_enabled, late_cancel_fee_mode, no_show_fee_mode, late_cancel_fee_percent_bp, no_show_fee_percent_bp",
    )
    .eq("id", studioId)
    .maybeSingle();
  if (error || !data) return null;
  return data as Row;
}

// The compare-and-set write. `expected` is the value the caller loaded; null is matched with IS NULL.
async function casWrite(studioId: string, column: string, expected: unknown, next: unknown): Promise<FeeSettingResult> {
  const supabase = await createClient();
  let q = supabase.from("studios").update({ [column]: next }).eq("id", studioId);
  q = expected === null ? q.is(column, null) : q.eq(column, expected as string | number | boolean);
  const { data, error } = await q.select("id");
  if (error) {
    console.error(
      JSON.stringify({ event: "update_studio_fee_setting_failed", code: dbErrorCode(error), column, timestamp: new Date().toISOString() }),
    );
    return { ok: false, error: SAVE_FAILED };
  }
  if (!data || data.length === 0) return { ok: false, error: STALE };
  revalidatePath("/settings/payments", "layout");
  return { ok: true };
}

/** Turn one fee type on or off. `expectedEnabled` is the saved value the page showed. */
export async function setManualFeeEnabledAction(input: {
  feeType: FeeType;
  enabled: boolean;
  expectedEnabled: boolean;
}): Promise<FeeSettingResult> {
  const studioId = await owner();
  if (!studioId) return { ok: false, error: OWNER_ONLY };
  if (!isFeeType(input?.feeType) || typeof input.enabled !== "boolean" || typeof input.expectedEnabled !== "boolean") {
    return { ok: false, error: SAVE_FAILED };
  }
  const row = await loadRow(studioId);
  if (!row) return { ok: false, error: SAVE_FAILED };
  if (input.enabled) {
    // Same validator prepare uses: ON only when the saved amount (fixed) or percentage (percent) can produce a fee.
    const issue = manualFeeConfigIssue(reason(input.feeType), row);
    if (issue === "percent_value") {
      return { ok: false, error: `Enter a ${NAME[input.feeType]} fee percentage before turning ${NAME[input.feeType]} fees on.` };
    }
    if (issue === "fixed_amount") {
      return { ok: false, error: `Enter a ${NAME[input.feeType]} fee amount above $0.00 before turning ${NAME[input.feeType]} fees on.` };
    }
    if (issue) return { ok: false, error: SAVE_FAILED };
  }
  return casWrite(studioId, col(input.feeType, "enabled"), input.expectedEnabled, input.enabled);
}

/** Choose fixed or percent for one fee type. `expectedMode` is the saved value the page showed. */
export async function setManualFeeModeAction(input: {
  feeType: FeeType;
  mode: "fixed" | "percent";
  expectedMode: "fixed" | "percent";
}): Promise<FeeSettingResult> {
  const studioId = await owner();
  if (!studioId) return { ok: false, error: OWNER_ONLY };
  if (
    !isFeeType(input?.feeType) ||
    (input.mode !== "fixed" && input.mode !== "percent") ||
    (input.expectedMode !== "fixed" && input.expectedMode !== "percent")
  ) {
    return { ok: false, error: SAVE_FAILED };
  }
  const row = await loadRow(studioId);
  if (!row) return { ok: false, error: SAVE_FAILED };
  // A fee that is ON must stay valid: do not switch to a mode that has no usable value yet.
  if (row[col(input.feeType, "enabled")] === true) {
    const issue = manualFeeConfigIssue(reason(input.feeType), { ...row, [col(input.feeType, "mode")]: input.mode });
    if (issue === "percent_value") {
      return { ok: false, error: `Set the ${NAME[input.feeType]} percentage first, or turn ${NAME[input.feeType]} fees off before switching.` };
    }
    if (issue === "fixed_amount") {
      return { ok: false, error: `Set the ${NAME[input.feeType]} fee amount first, or turn ${NAME[input.feeType]} fees off before switching.` };
    }
    if (issue) return { ok: false, error: SAVE_FAILED };
  }
  return casWrite(studioId, col(input.feeType, "mode"), input.expectedMode, input.mode);
}

/** Save the percentage for one fee type. `percentText` is what the owner typed ("75", "12.5"); `expectedBp` the saved value (null if none). */
export async function setManualFeePercentAction(input: {
  feeType: FeeType;
  percentText: string;
  expectedBp: number | null;
}): Promise<FeeSettingResult> {
  const studioId = await owner();
  if (!studioId) return { ok: false, error: OWNER_ONLY };
  if (!isFeeType(input?.feeType) || typeof input.percentText !== "string") return { ok: false, error: SAVE_FAILED };
  if (input.expectedBp !== null && !isValidPercentBp(input.expectedBp)) return { ok: false, error: SAVE_FAILED };
  const text = input.percentText.trim();
  let next: number | null;
  if (text === "") {
    next = null;
  } else {
    next = parsePercentTextToBp(text);
    if (next === null) return { ok: false, error: "The percentage must be between 0.01% and 100%, with up to two decimals." };
  }
  if (next === null) {
    const row = await loadRow(studioId);
    if (!row) return { ok: false, error: SAVE_FAILED };
    // Clearing the percentage of a fee that is ON in percent mode would leave it ON with nothing to calculate.
    if (row[col(input.feeType, "enabled")] === true && row[col(input.feeType, "mode")] === "percent") {
      return { ok: false, error: `Turn ${NAME[input.feeType]} fees off before clearing the percentage.` };
    }
  }
  return casWrite(studioId, col(input.feeType, "percent_bp"), input.expectedBp, next);
}
