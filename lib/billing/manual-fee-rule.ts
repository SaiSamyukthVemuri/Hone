import { MANUAL_FEE_AMOUNT_CEILING_CENTS } from "./manual-fee-types";
import { parsePercentTextToBp } from "./manual-fee-percent";

/** The exact saved rule the owner saw, including its independent on/off switch. */
export type ManualFeeRule = {
  enabled: boolean;
  mode: "fixed" | "percent";
  cents: number | null;
  percentBp: number | null;
};

/** Parse decimal text with integer arithmetic; blank clears an OFF rule. */
export function parseManualFeeRuleValue(mode: "fixed" | "percent", raw: string):
  { ok: true; value: number | null } | { ok: false; error: string } {
  const text = raw.trim();
  if (text === "") return { ok: true, value: null };
  if (mode === "percent") {
    const bp = parsePercentTextToBp(text);
    return bp === null
      ? { ok: false, error: "Enter a percentage from 0.01 to 100, with up to two decimals." }
      : { ok: true, value: bp };
  }
  const parts = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  const cents = parts ? Number(parts[1]) * 100 + Number((parts[2] ?? "").padEnd(2, "0")) : NaN;
  return Number.isSafeInteger(cents) && cents >= 0 && cents <= MANUAL_FEE_AMOUNT_CEILING_CENTS
    ? { ok: true, value: cents }
    : { ok: false, error: "Enter an amount from $0.00 to $200.00, with up to two decimals." };
}

export function isManualFeeRule(value: unknown): value is ManualFeeRule {
  if (!value || typeof value !== "object") return false;
  const rule = value as ManualFeeRule;
  return typeof rule.enabled === "boolean" && (rule.mode === "fixed" || rule.mode === "percent") &&
    [rule.cents, rule.percentBp].every((v) => v === null || (typeof v === "number" && Number.isSafeInteger(v)));
}
