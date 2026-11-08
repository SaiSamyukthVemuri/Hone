import type { AttentionItem, AttentionItemKind } from "./needs-attention-model";

// ===========================================================================
// Needs Attention: the identity of ONE item, for dismissal.
// ===========================================================================
//
// PURE. Dismissal is per INSTANCE: the stored identity is
//
//     item_key       what the item is about (kind + structured source id)
//     instance_token a stamp that changes when it is a NEW issue under the
//                    same key
//
// An item stays dismissed only while BOTH match. The key is the item's
// structured id, never rendered text (labels and names can change without the
// issue changing, and two issues can read the same).
//
// The stamp is supplied by the caller from the source row (the intake's
// submitted-at, the newest reaction record, the supply's expiry date). When a
// kind has no per-instance source, the token is the constant "1": one gap, and
// it ends when the record is finished.

/** The kind comes from the id's own shape for items the model did not build. */
export type AttentionIdentity = { itemKey: string; instanceToken: string };

/** Kinds whose instance changes with the source row. */
const STAMPED: ReadonlySet<AttentionItemKind | string> = new Set([
  "intake_review",
  "intake_incomplete",
  "treatment_memory",
]);

/** The stored token allows only [A-Za-z0-9:_.-] and 200 characters (0298), so a timestamp's "+" or space becomes "_". Deterministic. */
export function safeToken(raw: string): string {
  return raw.replace(/[^A-Za-z0-9:_.-]/g, "_").slice(0, 200);
}

export function attentionItemKey(item: Pick<AttentionItem, "id">): string {
  return item.id;
}

/**
 * `stamp` is the source row's own instance marker (ISO timestamp or record id).
 * A stamped kind WITHOUT a stamp gets a token no stored dismissal can match, so
 * an item whose instance cannot be told is shown, never hidden.
 */
export function attentionInstanceToken(
  item: Pick<AttentionItem, "kind">,
  stamp: string | null | undefined,
): string {
  if (!STAMPED.has(item.kind)) return "1";
  const s = typeof stamp === "string" ? stamp.trim() : "";
  return s === "" ? "unstamped" : safeToken(s);
}

/** An unstamped token never equals a stored one (see `isDismissed`). */
export function attentionIdentity(
  item: Pick<AttentionItem, "id" | "kind">,
  stamp: string | null | undefined,
): AttentionIdentity {
  return { itemKey: attentionItemKey(item), instanceToken: attentionInstanceToken(item, stamp) };
}

/** Unpaid finished appointment: one key per appointment. */
export function unpaidItemKey(appointmentId: string): string {
  return `unpaid:${appointmentId}`;
}
