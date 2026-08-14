import "server-only";
import { createClient } from "@/lib/supabase/server";

// ===========================================================================
// Clinical lineage enforcement (PR #286).
// ===========================================================================
//
// Charting mutations target a session/block/entry by id. Migration 0094
// guarantees same-STUDIO parent consistency (block ∈ session, entry ∈ block ∈
// session), and RLS scopes every read/write to the caller's studio, but
// neither proves that the session belongs to the CLIENT in the current route/
// form context. A stale tab, a bug, or a tampered form could submit a
// Client A route action with Client B's (same-studio) session/block/entry id
// and the write would be accepted, corrupting treatment memory.
//
// assertSessionForClient closes that gap: it proves the session belongs to
// BOTH the caller's studio AND the route client before any charting write.
// Because every block/entry write in the charting actions is already scoped by
// session_id (+ studio_id / block_id) and 0094 enforces block ∈ session and
// entry ∈ block ∈ session, validating session ∈ client makes the whole
// `studio → client → session → block → entry` chain client-correct.
//
// Defense-in-depth ABOVE RLS (not a replacement). The error is generic so it
// never reveals whether another client's session exists; valid same-client
// writes are unaffected.

export class SessionLineageError extends Error {}

// Throws SessionLineageError("Treatment session not found.") unless the
// session exists and belongs to BOTH the studio and the client. Uses the
// RLS-scoped client (studio gate stays primary); the client_id predicate is
// the route-client check this helper exists for.
export async function assertSessionForClient(
  studioId: string,
  clientId: string,
  sessionId: string,
): Promise<void> {
  if (!studioId || !clientId || !sessionId) {
    throw new SessionLineageError("Treatment session not found.");
  }
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .is("deleted_at", null)
    .maybeSingle();
  // A DB error is surfaced generically too, never leak the provider message,
  // and never accept the write on an indeterminate lineage result.
  if (error || !data) {
    throw new SessionLineageError("Treatment session not found.");
  }
}
