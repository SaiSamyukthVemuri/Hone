import "server-only";

import { createClient } from "@/lib/supabase/server";

/**
 * The block's current optimistic-concurrency token (`updated_at`), read as the
 * caller (RLS applies). Null when it cannot be read - the caller then hands the
 * form no new token, which leaves the real conflict check in force.
 */
export async function readBlockVersion(blockId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select("updated_at")
    .eq("id", blockId)
    .maybeSingle();
  return error || !data ? null : ((data as { updated_at: string }).updated_at ?? null);
}

/** When a recorded setup submission was committed (`recorded_at`), as the database prints it; null if unreadable. */
export async function readSubmissionRecordedAt(submissionId: string): Promise<string | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("treatment_setup_submissions")
    .select("recorded_at")
    .eq("id", submissionId)
    .maybeSingle();
  return error || !data ? null : ((data as { recorded_at: string }).recorded_at ?? null);
}
