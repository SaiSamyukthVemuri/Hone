import type { PermissionDef } from "./catalog";

// What kind of consequence a key carries, so the Roles page and its tests know to ask for a reason and how to word
// the warning. Informational: the reason RULE (adopt, reset, sensitive expansion) is unchanged and is decided by
// `sensitive` alone. One class per key; destructive outranks financial outranks sensitive.
export type ConsequenceClass = "financial" | "sensitive" | "destructive";

// Keys whose effect cannot be taken back by the person who later notices it. Reviewed list, not a pattern.
export const DESTRUCTIVE_KEYS: readonly string[] = ["appt.cancel", "pay.void", "pay.refund"];

const FINANCIAL_GROUPS: readonly string[] = ["payments", "pricing"];

export function consequenceClass(d: Pick<PermissionDef, "key" | "group" | "sensitive">): ConsequenceClass | null {
  if (DESTRUCTIVE_KEYS.includes(d.key)) return "destructive";
  if (FINANCIAL_GROUPS.includes(d.group)) return "financial";
  if (d.sensitive) return "sensitive";
  return null;
}
