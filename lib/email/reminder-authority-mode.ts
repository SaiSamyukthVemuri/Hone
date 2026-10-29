import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// ===========================================================================
// WHICH EMAIL-REMINDER AUTHORITY DOES THIS DATABASE HAVE?  (0247 compatibility)
// ===========================================================================
//
// Migration 0247 replaces the legacy reminder claim (claim_email_send /
// record_email_result, revoked from every API role) with the operation
// authority (inspect/prepare/authorize/observe_appointment_email_operation).
// This application must run correctly on BOTH sides of that migration, so the
// cron decides ONCE per run which authority the database actually has.
//
//   operation    0247 is applied: the inspect RPC exists and answers. Reminders
//                go through the operation authority ONLY. The legacy RPCs are
//                never called, so a revoked grant is never even attempted.
//   legacy       0247 is NOT applied: the inspect RPC does not exist. Reminders
//                use the pre-0247 claim path, unchanged.
//   unavailable  anything else (network error, timeout, permission error, an
//                answer of an unexpected shape). Reminders are HELD this run
//                and the run reports it; nothing is sent from a guess.
//
// WHY "inspect IS MISSING" CAN SAFELY MEAN LEGACY. The only way to be wrong in
// that direction is a stale PostgREST schema cache just after 0247 applies. The
// legacy path then calls claim_email_send, which 0247 has REVOKED in the
// database itself, so the call is refused and the claim reports unavailable:
// the row is held, nothing is sent. The reverse (operation chosen on a database
// without 0247) cannot happen because that function does not exist there.
// "Missing" is recognised ONLY by PostgREST's schema-cache code PGRST202 or
// Postgres' undefined_function 42883, never by a message or by any other error.
//
// THE PROBE IS A READ. It asks inspect about an appointment id that cannot
// exist (the nil UUID). inspect writes nothing and a nil id is never eligible,
// so the call has no effect; any well-formed JSON object answer proves the
// function is installed and callable by this role.

export type ReminderAuthorityMode = "operation" | "legacy" | "unavailable";

const NIL_UUID = "00000000-0000-0000-0000-000000000000";

export async function detectReminderAuthorityMode(admin: SupabaseClient): Promise<ReminderAuthorityMode> {
  try {
    const { data, error } = await admin.rpc("inspect_appointment_email_operation", {
      p_studio_id: NIL_UUID,
      p_appointment_id: NIL_UUID,
      p_purpose: "reminder_24h",
    });
    if (error) {
      return error.code === "PGRST202" || error.code === "42883" ? "legacy" : "unavailable";
    }
    return data !== null && typeof data === "object" && !Array.isArray(data) && typeof (data as { kind?: unknown }).kind === "string"
      ? "operation"
      : "unavailable";
  } catch {
    return "unavailable";
  }
}
