import type { SupabaseClient } from "@supabase/supabase-js";

// ===========================================================================
// THE ADMISSION ROUND IS PLUMBING, NOT A DECISION
// ===========================================================================
//
// 0192 will not issue an invitation without an open admission round, and every
// invitation carries the round's id. The owner never chooses a number: a send
// opens a round at the maximum allowance when none is open. A round that fills is
// rotated INSIDE 0324's admit, in the same transaction, so nothing here rotates.
// The limit that actually applies is 0324's guard, which counts the
// consultations that fit against live competing invitations under the studio
// lock.
//
// RESIDUE, STATED: the round table, the round id on each invitation and the
// "round_full" code still exist and are logged, but "used" has no meaning to the
// owner and nothing in the UI shows it.

export const AUTO_ROUND_ALLOWANCE = 100;

type Rpc = Pick<SupabaseClient, "rpc">;

function resultOf(data: unknown): string | null {
  const row = Array.isArray(data) ? data[0] : data;
  if (typeof row === "string") return row;
  if (row && typeof row === "object" && "result" in row) {
    const r = (row as { result?: unknown }).result;
    return typeof r === "string" ? r : null;
  }
  return null;
}

/** True when a round is open afterwards (opened now, or already open). */
export async function ensureOpenRound(admin: Rpc, studioId: string, actorUserId: string): Promise<boolean> {
  const { data, error } = await admin.rpc("open_new_client_waitlist_admission_round", {
    p_studio_id: studioId,
    p_actor_user_id: actorUserId,
    p_allowance: AUTO_ROUND_ALLOWANCE,
  });
  if (error) return false;
  const result = resultOf(data);
  return result === "opened" || result === "round_already_open";
}
