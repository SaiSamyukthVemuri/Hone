import type { PermissionDef } from "./catalog";

// What kind of consequence a key carries, so the Roles page and its tests know to ask for a reason and how to word
// the warning. Informational: the reason RULE (adopt, reset, sensitive expansion) is unchanged and is decided by
// `sensitive` alone. One class per key; financial outranks sensitive.
export type ConsequenceClass = "financial" | "sensitive" | "destructive";

// `destructive` is reserved for the protected deletion, archive and restore controls. Those are FIXED owner-only items, not
// catalog keys, so no delegable key is ever classed destructive (OPS, 3 Nov). Cancelling and voiding are ordinary or financial.
const FINANCIAL_GROUPS: readonly string[] = ["payments", "pricing"];

export function consequenceClass(d: Pick<PermissionDef, "key" | "group" | "sensitive">): ConsequenceClass | null {
  if (FINANCIAL_GROUPS.includes(d.group)) return "financial";
  if (d.sensitive) return "sensitive";
  return null;
}
