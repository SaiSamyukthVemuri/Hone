import type { ItemRow } from "./over-invite-progress";

// What the progress panel SHOWS and what the retry ACTS ON come from the same two functions, so the number on the confirm box is the number the
// action retries. Both read through the owner's own session (owner-only select policy) and post no ids.

export const BATCHES_SHOWN = 10;
const READ_PAGE = 1000;

type Reader = { from: (table: string) => any };

export type ShownBatch = { id: string; confirmed_at: string; quantity: number; fit_shown: number; live_shown: number };

/** The studio's most recent confirmed batches: the ones the panel shows. */
export async function loadShownBatches(db: Reader, studioId: string): Promise<ShownBatch[] | null> {
  const { data, error } = await db
    .from("waitlist_invitation_batches")
    .select("id,confirmed_at,quantity,fit_shown,live_shown")
    .eq("studio_id", studioId)
    .order("confirmed_at", { ascending: false })
    .limit(BATCHES_SHOWN);
  return error || !data ? null : (data as ShownBatch[]);
}

/** Every item row of one batch (paged, no cap). */
export async function loadBatchItems(db: Reader, studioId: string, batchId: string): Promise<ItemRow[] | null> {
  const rows: ItemRow[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await db
      .from("waitlist_invitation_batch_items")
      .select("state,reason_class,issued_at")
      .eq("studio_id", studioId)
      .eq("batch_id", batchId)
      .order("id", { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) return null;
    rows.push(...((data ?? []) as ItemRow[]));
    if (!data || data.length < READ_PAGE) return rows;
  }
}

/** The refused-delivery items of exactly the batches shown. These are the only retryable items. */
export async function loadRefusedTargets(db: Reader, studioId: string): Promise<{ entryId: string; itemId: string }[] | null> {
  const shown = await loadShownBatches(db, studioId);
  if (shown === null) return null;
  if (shown.length === 0) return [];
  const out: { entryId: string; itemId: string }[] = [];
  for (let from = 0; ; from += READ_PAGE) {
    const { data, error } = await db
      .from("waitlist_invitation_batch_items")
      .select("id,entry_id")
      .eq("studio_id", studioId)
      .in("batch_id", shown.map((b) => b.id))
      .eq("state", "failed")
      .eq("reason_class", "delivery_refused")
      .order("id", { ascending: true })
      .range(from, from + READ_PAGE - 1);
    if (error) return null;
    for (const r of data ?? []) out.push({ entryId: String(r.entry_id), itemId: String(r.id) });
    if (!data || data.length < READ_PAGE) return out;
  }
}

/**
 * The unknown-outcome items of exactly the batches shown: settled `unknown`, or a failed item whose last attempt ended unknown. Retried ONLY by the
 * owner's separate, more strongly confirmed action. An `issued` item still inside its lease is "sending", and one past it becomes `unknown` at the
 * next claim; neither is a target until then.
 */
export async function loadUnknownTargets(db: Reader, studioId: string): Promise<{ entryId: string; itemId: string }[] | null> {
  const shown = await loadShownBatches(db, studioId);
  if (shown === null) return null;
  if (shown.length === 0) return [];
  const ids = shown.map((b) => b.id);
  const out: { entryId: string; itemId: string }[] = [];
  const kinds: [string, string | null][] = [["unknown", null], ["failed", "delivery_unknown"]];
  for (const [state, reason] of kinds) {
    for (let from = 0; ; from += READ_PAGE) {
      let q = db.from("waitlist_invitation_batch_items").select("id,entry_id").eq("studio_id", studioId).in("batch_id", ids).eq("state", state);
      if (reason) q = q.eq("reason_class", reason);
      const { data, error } = await q.order("id", { ascending: true }).range(from, from + READ_PAGE - 1);
      if (error) return null;
      for (const r of data ?? []) out.push({ entryId: String(r.entry_id), itemId: String(r.id) });
      if (!data || data.length < READ_PAGE) break;
    }
  }
  return out;
}
