// HON-58 Q1 — the per-studio switch that lets receptionists see client legal names (0266).
// No row means OFF; a failed read is "unavailable", never a silent OFF or ON.
import type { SupabaseClient } from "@supabase/supabase-js";

export type LegalNameAccessRead = { ok: true; receptionistAccess: boolean } | { ok: false };

export async function readReceptionistLegalNameAccess(
  supabase: SupabaseClient,
  studioId: string,
): Promise<LegalNameAccessRead> {
  const { data, error } = await supabase
    .from("studio_legal_name_access")
    .select("receptionist_access")
    .eq("studio_id", studioId)
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, receptionistAccess: (data as { receptionist_access?: boolean } | null)?.receptionist_access === true };
}
