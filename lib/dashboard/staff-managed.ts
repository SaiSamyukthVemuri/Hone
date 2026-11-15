// HON-65: the dashboard's "staff-managed clinic" posture, derived ONLY from the two existing HON-47 studio settings
// (client_cancellation_enabled, client_reschedule_enabled; migration 0234, default true). It is NOT a portal-off flag: no such flag exists
// (that is a separate, held workstream). A studio is staff-managed here only when BOTH client self-service settings are explicitly false.
// Anything else, including a missing row, null columns or a failed read, is the default posture, so the dashboard never changes
// behaviour on missing or uncertain data.
import type { SupabaseClient } from "@supabase/supabase-js";

export type ClientSelfServiceSettings = {
  client_cancellation_enabled?: boolean | null;
  client_reschedule_enabled?: boolean | null;
} | null | undefined;

export function isStaffManagedClinic(settings: ClientSelfServiceSettings): boolean {
  return settings?.client_cancellation_enabled === false && settings?.client_reschedule_enabled === false;
}

// WS-DB: the same read, but a failed read is reported as UNKNOWN instead of being folded into "not staff-managed". The dashboard still falls back to the
// default posture for COPY (unchanged), but it can now say so out loud. `loadStaffManagedClinic` below keeps its original contract.
export const STAFF_MANAGED_UNKNOWN = "unknown" as const;

export async function loadStaffManagedClinicChecked(
  supabase: SupabaseClient,
  studioId: string,
): Promise<boolean | typeof STAFF_MANAGED_UNKNOWN> {
  try {
    const { data, error } = await supabase
      .from("studios")
      .select("client_cancellation_enabled, client_reschedule_enabled")
      .eq("id", studioId)
      .maybeSingle();
    if (error) return STAFF_MANAGED_UNKNOWN;
    return isStaffManagedClinic(data as ClientSelfServiceSettings);
  } catch {
    return STAFF_MANAGED_UNKNOWN;
  }
}

// One bounded read, scoped to the caller's own studio id. A read error resolves to the default posture (false); the dashboard never throws for it.
export async function loadStaffManagedClinic(supabase: SupabaseClient, studioId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("studios")
      .select("client_cancellation_enabled, client_reschedule_enabled")
      .eq("id", studioId)
      .maybeSingle();
    if (error) return false;
    return isStaffManagedClinic(data as ClientSelfServiceSettings);
  } catch {
    return false;
  }
}
