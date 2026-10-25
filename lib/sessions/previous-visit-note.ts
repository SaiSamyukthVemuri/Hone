import { createClient } from "@/lib/supabase/server";

// HON-10. The chart page's "From last visit" note: the newest earlier,
// non-void session of THIS client in THIS studio that carries a next-visit
// note.
//
// It used to be inline on the page as `const { data } = ...`, which discarded
// the read's error: a failed read arrived as `null` and rendered as "no note",
// the same false absence #642/#648 closed on the client profile and the
// dashboard. `unavailable` is the difference between "nothing was written" and
// "we did not find out".
//
// The order is `started_at desc, id desc`, the shared recency rule
// (lib/sessions/charted-session.ts, migration 0157): `started_at` alone is not
// a total order, and two sessions sharing a minute (an "Edit time" correction)
// came back in whichever order Postgres chose.
//
// Classification only in the log: the SQLSTATE and the studio id. Never the
// message, a client id or a session id.
export type PreviousVisitNote = { note: string | null; unavailable: boolean };

export async function loadPreviousVisitNote(input: {
  studioId: string;
  clientId: string;
  before: string;
}): Promise<PreviousVisitNote> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("sessions")
      .select("id, started_at, next_session_note")
      .eq("studio_id", input.studioId)
      .eq("client_id", input.clientId)
      .is("deleted_at", null)
      // HON-10 row 1: a void session's note is never "From last visit".
      // record_status is NOT NULL (0119), so `neq` drops nothing else.
      .neq("record_status", "void")
      .not("next_session_note", "is", null)
      .lt("started_at", input.before)
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      logFailure(input.studioId, error.code);
      return { note: null, unavailable: true };
    }
    return {
      note:
        (data as { next_session_note?: string | null } | null)?.next_session_note?.trim() ||
        null,
      unavailable: false,
    };
  } catch {
    logFailure(input.studioId, null);
    return { note: null, unavailable: true };
  }
}

function logFailure(studioId: string, code: unknown): void {
  console.error(
    JSON.stringify({
      event: "previous_visit_note_read_failed",
      code: typeof code === "string" ? code : null,
      studio_id: studioId,
      at: new Date().toISOString(),
    }),
  );
}
