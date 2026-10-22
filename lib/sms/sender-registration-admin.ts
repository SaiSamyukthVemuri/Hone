import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseLiveRegistrationState, type LiveRegistrationState } from "./sender-registration";

// SMS-SENDER-REG-01 (#824): the OPERATOR console's read of 0217's snapshot,
// get_live_studio_sms_sender_registration_state, through the service-role
// client the /admin pages already use. Kept apart from sender-registration.ts,
// which is the studio owner's session-only, no-RPC read (pinned by
// tests/source-guards/sms-status-readonly-boundary.test.ts).

export async function readLiveRegistrationState(
  admin: SupabaseClient,
  studioId: string,
): Promise<LiveRegistrationState> {
  try {
    const { data, error } = await admin.rpc("get_live_studio_sms_sender_registration_state", {
      p_studio_id: studioId,
    });
    if (error) return { ok: false };
    return parseLiveRegistrationState(data, studioId);
  } catch {
    return { ok: false };
  }
}
