import { MANUAL_FEE_AMOUNT_CEILING_CENTS } from "@/lib/billing/manual-fee-types";

// Percent-of-session-price manual fee: the calculation, and nothing else. PURE: no I/O, no clock.
//
// DEFINITION (also stated in the PR body). fee = round-half-up(basis_cents * percent_bp / 10000), rounded ONCE, in integer
// arithmetic. basis_cents is the appointment's session price exactly as Hone would charge it for a session
// (lib/billing/session-payment-amount.ts: the client's current custom price for the booked service, else the service menu
// price). Nothing is added or subtracted: no tax is calculated or added to the fee, and no discount, promotion, package,
// deposit or store credit is applied, because none of those exists as a price rule in the application.
//
// REFUSALS (no fallback to the fixed amount, no cap, no substitution):
//   * price missing, free, ambiguous or unreadable (decided by the loader, not here)
//   * result is 0
//   * result is at or above MANUAL_FEE_AMOUNT_CEILING_CENTS (the same ceiling a fixed fee must stay UNDER is the
//     existing `cents > ceiling` rule for fixed fees; for percent the owner asked for "at or above" to refuse)

export const PERCENT_BP_MIN = 1;
export const PERCENT_BP_MAX = 10000;
/** floor((MAX_SAFE_INTEGER - 5000) / PERCENT_BP_MAX): the largest basis for which basis * bp + 5000 is still a safe integer at 100%. */
export const MAX_PERCENT_BASIS_CENTS = Math.floor((Number.MAX_SAFE_INTEGER - 5000) / PERCENT_BP_MAX);

export type PercentFeeRefusal = "invalid_percent" | "invalid_basis" | "at_or_above_ceiling";

// A fee of exactly $0.00 is NOT a refusal and not an error: it is a calculated answer ("no fee is owed"). It is its own
// variant so it can never be mistaken for a chargeable amount: ok is false, no amount is exposed, no attempt is created.
export type PercentFeeResult =
  | { ok: true; amountCents: number; basisCents: number; percentBp: number }
  | { ok: false; reason: "no_fee_owed"; basisCents: number; percentBp: number }
  | { ok: false; reason: PercentFeeRefusal };

export function isValidPercentBp(bp: unknown): bp is number {
  return typeof bp === "number" && Number.isInteger(bp) && bp >= PERCENT_BP_MIN && bp <= PERCENT_BP_MAX;
}

/** Integer half-up: floor((basis * bp + 5000) / 10000). No floating point, so a .5 boundary cannot misround. */
export function roundHalfUpPercentCents(basisCents: number, percentBp: number): number {
  return Math.floor((basisCents * percentBp + 5000) / 10000);
}

export function computePercentFee(basisCents: unknown, percentBp: unknown): PercentFeeResult {
  if (!isValidPercentBp(percentBp)) return { ok: false, reason: "invalid_percent" };
  // Basis 0 (an explicit $0 price) is a real price and gives a zero fee. null, negative, fractional or non-numeric is
  // not a price at all: invalid_basis.
  if (typeof basisCents !== "number" || !Number.isSafeInteger(basisCents) || basisCents < 0) {
    return { ok: false, reason: "invalid_basis" };
  }
  // Bound the basis BEFORE multiplying: basis x bp (+5000) must stay a safe integer, or the integer arithmetic silently loses
  // precision. A price anywhere near this is not a real price; refuse it (no cap, no fallback).
  if (basisCents > MAX_PERCENT_BASIS_CENTS) return { ok: false, reason: "invalid_basis" };
  const amountCents = roundHalfUpPercentCents(basisCents, percentBp);
  if (amountCents <= 0) return { ok: false, reason: "no_fee_owed", basisCents, percentBp };
  if (amountCents >= MANUAL_FEE_AMOUNT_CEILING_CENTS) return { ok: false, reason: "at_or_above_ceiling" };
  return { ok: true, amountCents, basisCents, percentBp };
}

export function percentFeeRefusalMessage(reason: PercentFeeRefusal): string {
  switch (reason) {
    case "invalid_percent":
      return "The fee percentage is not set. Set it in Settings, Payments.";
    case "invalid_basis":
      return "This appointment's service price could not be used to calculate a percentage fee.";
    case "at_or_above_ceiling":
      return "The percentage fee for this appointment is above the maximum a single fee may be, so no fee was prepared. Nothing was capped or changed.";
  }
}

/** "Appointment price $0.00 x 75% = $0.00. No fee is owed, so there is nothing to prepare." Not an error. */
export function noFeeOwedMessage(basisCents: number, percentBp: number): string {
  return `Appointment price ${dollars(basisCents)} \u00d7 ${formatBasisPoints(percentBp)} = $0.00. No fee is owed, so there is nothing to prepare.`;
}

/** "75% of $120.00 session price = $90.00" (currency code is appended by the caller). */
export function formatBasisPoints(bp: number): string {
  const whole = Math.floor(bp / 100);
  const frac = bp % 100;
  return frac === 0 ? `${whole}%` : `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

// ---------------------------------------------------------------------------
// Configuration validity: ONE validator shared by prepare (eligibility), the Settings actions and the "Active" display.
// ---------------------------------------------------------------------------

export type FixedFeeCentsIssue = "not_configured" | "out_of_range" | null;

/** NULL and 0 are "not configured"; negative or above the ceiling is out of range (the ceiling itself is allowed for a fixed fee). */
export function fixedFeeCentsIssue(cents: unknown): FixedFeeCentsIssue {
  if (cents == null || cents === 0) return "not_configured";
  if (typeof cents !== "number" || !Number.isInteger(cents) || cents < 0 || cents > MANUAL_FEE_AMOUNT_CEILING_CENTS) {
    return "out_of_range";
  }
  return null;
}

export type FeeConfigRow = {
  late_cancel_fee_cents?: unknown;
  no_show_fee_cents?: unknown;
  late_cancel_fee_mode?: unknown;
  no_show_fee_mode?: unknown;
  late_cancel_fee_percent_bp?: unknown;
  no_show_fee_percent_bp?: unknown;
} | null;

/** null when the saved configuration for this type can produce a fee; otherwise why it cannot. Unknown mode fails closed. */
export function manualFeeConfigIssue(
  chargeReason: "late_cancellation_fee" | "no_show_fee",
  row: FeeConfigRow,
): "fixed_amount" | "percent_value" | "mode" | null {
  if (!row) return "mode";
  const late = chargeReason === "late_cancellation_fee";
  const mode = late ? row.late_cancel_fee_mode : row.no_show_fee_mode;
  if (mode === "percent") return isValidPercentBp(late ? row.late_cancel_fee_percent_bp : row.no_show_fee_percent_bp) ? null : "percent_value";
  if (mode === "fixed") return fixedFeeCentsIssue(late ? row.late_cancel_fee_cents : row.no_show_fee_cents) === null ? null : "fixed_amount";
  return "mode";
}

/** "75" -> 7500, "12.5" -> 1250, "12.34" -> 1234. Text only, integer arithmetic. null when not a valid percentage in 0.01..100. */
export function parsePercentTextToBp(raw: string): number | null {
  const s = raw.trim().replace(/%$/, "").trim();
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0") || "0");
  return isValidPercentBp(bp) ? bp : null;
}

function dollars(cents: number): string {
  return "$" + String(Math.floor(cents / 100)) + "." + String(cents % 100).padStart(2, "0");
}

/**
 * The owner-facing statement of how a fee amount was derived. Percent: "75% of $120.00 session price = $90.00 CAD".
 * Fixed (or an attempt prepared before 0351): "$50.00 CAD". Pure; never calculates, only prints what was frozen.
 */
export function describeFeeAmount(a: {
  calcMode: "fixed" | "percent" | null | undefined;
  basisCents: number | null | undefined;
  percentBp: number | null | undefined;
  amountCents: number;
  currency: string;
}): string {
  const cur = a.currency.toUpperCase();
  if (a.calcMode === "percent" && typeof a.basisCents === "number" && typeof a.percentBp === "number") {
    return `${formatBasisPoints(a.percentBp)} of ${dollars(a.basisCents)} session price = ${dollars(a.amountCents)} ${cur}`;
  }
  return `${dollars(a.amountCents)} ${cur}`;
}
