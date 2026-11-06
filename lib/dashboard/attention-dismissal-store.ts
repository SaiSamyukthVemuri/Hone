import { after } from "next/server";
import "server-only";

import { createClient } from "@/lib/supabase/server";
import type { StoredDismissal } from "./attention-dismissal";

// The ONLY reader of the signed-in owner's dismissals (migration 0298, held). The database command is owner-only and scoped to the
// caller's own user id, so this returns THIS owner's dismissals and nobody else's. A read that fails is "unavailable": the caller then
// shows every reminder (nothing is hidden on a guess) and offers no Dismiss, because it could not tell what is already dismissed.

export type DismissalRead = { ok: true; rows: StoredDismissal[]; capped: boolean } | { ok: false };

export async function loadMyDismissals(studioId: string): Promise<DismissalRead> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc("list_dismissed_attention", { p_studio: studioId });
    if (error || typeof data !== "object" || data === null || (data as { ok?: unknown }).ok !== true) return { ok: false };
    const raw = (data as { rows?: unknown; capped?: unknown }).rows;
    if (!Array.isArray(raw)) return { ok: false };
    const rows: StoredDismissal[] = [];
    for (const r of raw) {
      const o = r as { item_key?: unknown; instance_token?: unknown };
      if (typeof o?.item_key === "string" && typeof o?.instance_token === "string") rows.push({ itemKey: o.item_key, instanceToken: o.instance_token });
    }
    return { ok: true, rows, capped: (data as { capped?: unknown }).capped === true };
  } catch {
    return { ok: false };
  }
}

// Privacy AP2: restore the dismissals of studio reminders that have resolved (see resolvedStudioDismissalKeys). Uses ONLY the existing restore
// command (an appended `restore` event for the caller's own dismissal); it touches no balance, payment, setup status, message or access.
// Best effort: a failure leaves the dismissal in place, which is exactly the state before this ran.
// NOT on the render path (AP2-3): the client is built here (it needs the request's cookies), but the restore calls run in after(), once the
// response is sent, and their results are not read, so a slow or failing restore can never delay or break the dashboard.
export async function restoreResolvedDismissals(studioId: string, itemKeys: ReadonlyArray<string>): Promise<void> {
  if (itemKeys.length === 0) return;
  try {
    const supabase = await createClient();
    after(async () => {
      try {
        await Promise.all(itemKeys.map((k) => supabase.rpc("restore_attention_item", { p_studio: studioId, p_item_key: k })));
      } catch {
        // intentionally silent: nothing to report to the owner, and no raw error leaves this function
      }
    });
  } catch {
    // intentionally silent: the dismissal simply stays until the next load
  }
}
