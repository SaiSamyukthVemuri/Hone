"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { manualFeeConfigIssue, parsePercentTextToBp, isValidPercentBp } from "@/lib/billing/manual-fee-percent";
import { dbErrorCode } from "@/lib/logging/error-class";
import { isManualFeeRule, parseManualFeeRuleValue, type ManualFeeRule } from "@/lib/billing/manual-fee-rule";

// Owner-only manual-fee settings (migration 0351). Each legacy set action writes exactly one column and is
// a COMPARE-AND-SET against the value the page loaded: the UPDATE carries `where <column> = <value the owner saw>`, so a tab
// that went stale cannot silently overwrite a newer choice (a stale tab can no longer flip a fee back ON, or switch its
// mode). Zero rows updated means "changed elsewhere": the owner is told to refresh, and nothing was written.
//
// None of these actions can charge anyone. saveManualFeeRuleAction saves one rule atomically without touching
// its enabled switch or the other fee. The older single-setting actions remain compatible with existing callers.
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
// `guards` are OTHER columns the validity check read (loadRow): the write also requires them to be unchanged, so a concurrent change to one
// of them (another tab turning the switch ON, clearing the percentage...) makes this write STALE instead of leaving an enabled, unusable setting.
type Guard = [column: string, value: unknown];
function guardsFor(row: Row, type: FeeType, whats: Array<"enabled" | "mode" | "percent_bp" | "cents">): Guard[] {
  return whats.map((w) => [col(type, w), row[col(type, w)] ?? null] as Guard);
}
async function casWrite(studioId: string, column: string, expected: unknown, next: unknown, guards: Guard[] = []): Promise<FeeSettingResult> {
  const supabase = await createClient();
  let q = supabase.from("studios").update({ [column]: next }).eq("id", studioId);
  q = expected === null ? q.is(column, null) : q.eq(column, expected as string | number | boolean);
  for (const [gc, gv] of guards) q = gv === null ? q.is(gc, null) : q.eq(gc, gv as string | number | boolean);
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
  expectedRule?: ManualFeeRule;
}): Promise<FeeSettingResult> {
  const studioId = await owner();
  if (!studioId) return { ok: false, error: OWNER_ONLY };
  if (!isFeeType(input?.feeType) || typeof input.enabled !== "boolean" || typeof input.expectedEnabled !== "boolean") {
    return { ok: false, error: SAVE_FAILED };
  }
  const row = await loadRow(studioId);
  if (!row) return { ok: false, error: SAVE_FAILED };
  // The redesigned confirmation names the rule the owner saw, not a newer rule from another tab.
  if (input.enabled && input.expectedRule !== undefined &&
    (!isManualFeeRule(input.expectedRule) || input.expectedRule.enabled !== input.expectedEnabled)) {
    return { ok: false, error: SAVE_FAILED };
  }
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
  // Turning ON was validated against the mode, percentage and amount just read: they must still be those values at the write.
  return casWrite(studioId, col(input.feeType, "enabled"), input.expectedEnabled, input.enabled,
    input.enabled ? (input.expectedRule ? ruleGuards(input.feeType, input.expectedRule) : guardsFor(row, input.feeType, ["mode", "percent_bp", "cents"])) : []);
}

function ruleGuards(type: FeeType, rule: ManualFeeRule): Guard[] {
  return [[col(type, "enabled"), rule.enabled], [col(type, "mode"), rule.mode],
    [col(type, "cents"), rule.cents], [col(type, "percent_bp"), rule.percentBp]];
}

/** One Save rule: one UPDATE, one fee, owner session/RLS/audit, with all four saved values as CAS guards. */
export async function saveManualFeeRuleAction(input: {
  feeType: FeeType;
  mode: "fixed" | "percent";
  valueText: string;
  expected: ManualFeeRule;
}): Promise<FeeSettingResult> {
  const studioId = await owner();
  if (!studioId) return { ok: false, error: OWNER_ONLY };
  if (!isFeeType(input?.feeType) || (input.mode !== "fixed" && input.mode !== "percent") ||
    typeof input.valueText !== "string" || !isManualFeeRule(input.expected)) {
    return { ok: false, error: SAVE_FAILED };
  }
  const parsed = parseManualFeeRuleValue(input.mode, input.valueText);
  if (!parsed.ok) return parsed;
  if (input.expected.enabled && (parsed.value === null || parsed.value === 0)) {
    return { ok: false, error: `Turn ${NAME[input.feeType]} fees off before clearing or zeroing the rule.` };
  }
  const valueColumn = col(input.feeType, input.mode === "fixed" ? "cents" : "percent_bp");
  const supabase = await createClient();
  let q = supabase.from("studios").update({ [col(input.feeType, "mode")]: input.mode, [valueColumn]: parsed.value }).eq("id", studioId);
  for (const [column, value] of ruleGuards(input.feeType, input.expected)) {
    q = value === null ? q.is(column, null) : q.eq(column, value as string | number | boolean);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error(JSON.stringify({ event: "update_studio_fee_rule_failed", code: dbErrorCode(error), timestamp: new Date().toISOString() }));
    return { ok: false, error: SAVE_FAILED };
  }
  if (!data?.length) return { ok: false, error: STALE };
  revalidatePath("/settings/payments", "layout");
  return { ok: true };
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
  // The check above depends on whether the fee is ON and on the percentage and amount: all must be unchanged at the write.
  return casWrite(studioId, col(input.feeType, "mode"), input.expectedMode, input.mode, guardsFor(row, input.feeType, ["enabled", "percent_bp", "cents"]));
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
  let guards: Guard[] = [];
  if (next === null) {
    const row = await loadRow(studioId);
    if (!row) return { ok: false, error: SAVE_FAILED };
    // Clearing the percentage of a fee that is ON in percent mode would leave it ON with nothing to calculate.
    if (row[col(input.feeType, "enabled")] === true && row[col(input.feeType, "mode")] === "percent") {
      return { ok: false, error: `Turn ${NAME[input.feeType]} fees off before clearing the percentage.` };
    }
    // Clearing was allowed because the fee was OFF (or not percent): it must still be at the write.
    guards = guardsFor(row, input.feeType, ["enabled", "mode"]);
  }
  return casWrite(studioId, col(input.feeType, "percent_bp"), input.expectedBp, next, guards);
}
