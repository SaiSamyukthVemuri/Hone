import "server-only";

import { LEGACY_MACHINE_PROFILE_ID } from "@/lib/machines/legacy-machine";
import { createClient } from "@/lib/supabase/server";

export type ClientLastMachine = {
  profileId: string | null;
  deviceId: string | null;
  modeKey: string | null;
};

/**
 * The machine recorded on THIS CLIENT's most recent treatment area (0301), read as
 * the caller (RLS applies). Null when the client has none, or when the identity
 * columns are not there yet (0301 unapplied) or the read fails: the caller then
 * falls back to the practitioner's remembered preference. This is the client's
 * own history, not a preference, so it outranks the preference.
 */
export async function readClientLastMachine(clientId: string): Promise<ClientLastMachine | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select("machine_profile_id, studio_machine_id, machine_mode_key, mode, sessions!inner(client_id)")
    .eq("sessions.client_id", clientId)
    // A deleted or void visit is not the client's last machine (Privacy EL-2a, Insurance N-5).
    .is("sessions.deleted_at", null)
    .neq("sessions.record_status", "void")
    .is("deleted_at", null)
    // A saved identity, OR the existing xCell workflow charted without choosing it (a legacy mode, no identity).
    .or("machine_profile_id.not.is.null,mode.not.is.null")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return readLegacyOnlyLastMachine(clientId);
  if (!Array.isArray(data) || data.length === 0) return null;
  const r = data[0] as {
    machine_profile_id: string | null;
    studio_machine_id: string | null;
    machine_mode_key: string | null;
    mode: string | null;
  };
  if (r.machine_profile_id == null) return legacyLast();
  return { profileId: r.machine_profile_id, deviceId: r.studio_machine_id, modeKey: r.machine_mode_key };
}

/** The existing workflow's profile; validation still requires the studio to be offered it. */
function legacyLast(): ClientLastMachine {
  return { profileId: LEGACY_MACHINE_PROFILE_ID, deviceId: null, modeKey: null };
}

/** 0301 unapplied (the identity columns do not exist): the only history there is, is the existing workflow's. */
async function readLegacyOnlyLastMachine(clientId: string): Promise<ClientLastMachine | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .select("mode, sessions!inner(client_id)")
    .eq("sessions.client_id", clientId)
    .is("sessions.deleted_at", null)
    .neq("sessions.record_status", "void")
    .is("deleted_at", null)
    .not("mode", "is", null)
    .limit(1);
  if (error || !Array.isArray(data) || data.length === 0) return null;
  return legacyLast();
}
