import { createClient } from "@/lib/supabase/server";
import { dbErrorCode } from "@/lib/logging/error-class";

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
//
// HON-10 F4. A BLANK NOTE IS NOT A NOTE. The amendment RPC (0120) stores the
// note untrimmed, so an amended session can carry "" or whitespace. The read
// takes the few newest non-null notes and the first with text wins; a window of
// nothing but blanks proves nothing about the older history, so it is
// `unavailable`, never "no note".
//
// HON-10 identity: the note carries the identity of the session it was WRITTEN on (that session's id and start time), because the "Last treatment" card
// follows a different rule (the newest CHARTED session) and the two can come from different visits. `session` is null exactly when `note` is null.
export type PreviousVisitNote = {
  note: string | null;
  unavailable: boolean;
  session: { id: string; startedAt: string } | null;
};

const NOTE_WINDOW = 10;

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
      .limit(NOTE_WINDOW);
    if (error) {
      logFailure(input.studioId, dbErrorCode(error));
      return { note: null, unavailable: true, session: null };
    }
    const rows = (Array.isArray(data) ? data : []) as Array<{
      id?: string | null;
      started_at?: string | null;
      next_session_note?: string | null;
    }>;
    for (const r of rows) {
      const text = r.next_session_note?.trim();
      if (text) {
        // A note is only ever shown with the visit it came from; a row that lost its identity is not shown as a note.
        if (!r.id || !r.started_at) return { note: null, unavailable: true, session: null };
        return { note: text, unavailable: false, session: { id: r.id, startedAt: r.started_at } };
      }
    }
    return { note: null, unavailable: rows.length >= NOTE_WINDOW, session: null };
  } catch {
    logFailure(input.studioId, null);
    return { note: null, unavailable: true, session: null };
  }
}

function logFailure(studioId: string, code: string | null): void {
  console.error(
    JSON.stringify({
      event: "previous_visit_note_read_failed",
      code,
      studio_id: studioId,
      at: new Date().toISOString(),
    }),
  );
}
