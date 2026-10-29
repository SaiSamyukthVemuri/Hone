import type { SettlementMethod } from "@/lib/billing/settlement-types";

// HON-45. How a recorded external payment compares with the quoted visit price.
// Display only: it invents no status, balance or total and writes nothing. A
// missing quote is "unknown", never assumed full.

export type SettlementCoverage =
  | { kind: "full" }
  | { kind: "part"; collectedCents: number; quotedCents: number; shortfallCents: number }
  | { kind: "unknown" }
  | { kind: "not_applicable" };

const COLLECTED: ReadonlySet<SettlementMethod> = new Set([
  "paid_cash",
  "paid_e_transfer",
  "paid_other_external",
]);

export function settlementCoverage(
  method: SettlementMethod,
  amountCents: number,
  quotedAmountCents: number | null | undefined,
): SettlementCoverage {
  if (!COLLECTED.has(method)) return { kind: "not_applicable" };
  if (typeof quotedAmountCents !== "number") return { kind: "unknown" };
  if (amountCents >= quotedAmountCents) return { kind: "full" };
  return {
    kind: "part",
    collectedCents: amountCents,
    quotedCents: quotedAmountCents,
    shortfallCents: quotedAmountCents - amountCents,
  };
}
