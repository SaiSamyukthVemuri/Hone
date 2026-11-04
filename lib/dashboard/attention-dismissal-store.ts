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
