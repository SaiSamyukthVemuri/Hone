// Server-only loader for practitioner-only client personal notes
// (migration 0035). Returns null when no row exists so the UI can
// render an empty state without an extra round-trip to create an empty
// row.
//
// This helper is imported only by the authenticated client profile
// page (app/(app)/clients/[id]/page.tsx). It must NOT be imported by
// app/book/*, lib/email/*, app/intake/*, app/cancel/*, app/reschedule/*,
// app/api/cron/*, or app/api/stripe/*. The import audit in PR #27
// enforces this contract.

import { createClient } from "@/lib/supabase/server";
import type { ClientPersonalNotes } from "@/lib/types/database";

export async function getClientPersonalNotes(
  studioId: string,
  clientId: string,
): Promise<ClientPersonalNotes | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("client_personal_notes")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `Failed to load client personal notes: ${error.message}`,
    );
  }
  return (data ?? null) as ClientPersonalNotes | null;
}
