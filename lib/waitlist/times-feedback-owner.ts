import { createAdminClient } from "@/lib/supabase/admin-server";

// 0319 — the OWNER's side of "these times don't work".
//
// Every function takes the studio and actor from the caller's SESSION; the
// database re-checks the owner. The COUNT never selects text. The LIST is the
// only reader of a recipient's note, it is reached only from the owner-gated
// replies page, and nothing here logs a row or an error body.

export type TimesFeedbackCount = { kind: "unknown" } | { kind: "ok"; n: number };

export type TimesFeedbackRow = {
  invitationId: string;
  entryName: string;
  note: string | null;
  createdAt: string;
};

export type TimesFeedbackList = { kind: "unknown" } | { kind: "ok"; rows: TimesFeedbackRow[] };

export async function countTimesFeedback(studioId: string, actorUserId: string | null): Promise<TimesFeedbackCount> {
  if (!actorUserId) return { kind: "unknown" };
  try {
    const { data, error } = await createAdminClient().rpc("count_waitlist_times_feedback", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
    });
    if (error || !Array.isArray(data) || data.length === 0) return { kind: "unknown" };
    const row = data[0] as { result?: unknown; n?: unknown };
    if (row.result !== "ok" || typeof row.n !== "number") return { kind: "unknown" };
    return { kind: "ok", n: row.n };
  } catch {
    return { kind: "unknown" };
  }
}

export async function listTimesFeedback(studioId: string, actorUserId: string | null): Promise<TimesFeedbackList> {
  if (!actorUserId) return { kind: "unknown" };
  try {
    const { data, error } = await createAdminClient().rpc("list_waitlist_times_feedback", {
      p_studio_id: studioId,
      p_actor_user_id: actorUserId,
    });
    if (error || !Array.isArray(data)) return { kind: "unknown" };
    if (data.length > 0 && (data[0] as { result?: unknown }).result !== "ok") return { kind: "unknown" };
    const rows: TimesFeedbackRow[] = [];
    for (const r of data as Array<Record<string, unknown>>) {
      if (typeof r.invitation_id !== "string" || typeof r.entry_name !== "string") return { kind: "unknown" };
      rows.push({
        invitationId: r.invitation_id,
        entryName: r.entry_name,
        note: typeof r.note === "string" ? r.note : null,
        createdAt: typeof r.created_at === "string" ? r.created_at : "",
      });
    }
    return { kind: "ok", rows };
  } catch {
    return { kind: "unknown" };
  }
}

export async function acknowledgeTimesFeedback(
  studioId: string,
  invitationId: string,
  actorUserId: string | null,
): Promise<boolean> {
  if (!actorUserId) return false;
  try {
    const { data, error } = await createAdminClient().rpc("acknowledge_waitlist_times_feedback", {
      p_studio_id: studioId,
      p_invitation_id: invitationId,
      p_actor_user_id: actorUserId,
    });
    return !error && data === "acknowledged";
  } catch {
    return false;
  }
}
