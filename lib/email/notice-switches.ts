import type { SupabaseClient } from "@supabase/supabase-js";
import { STUDIO_SETTINGS, resolveStudioSetting } from "@/lib/studio/settings";

// The studio's two client-notice switches (0373), read LIVE at send time so a flip takes effect on work already in flight.
//
//   send_moved_appointment_emails     the email to a client whose appointment was moved or reassigned
//   send_client_cancellation_emails   the email to a client whose appointment the studio cancelled
//
// Both are independent of send_confirmation_emails, and neither governs an OWNER notice.
//
// Three answers, and an unreadable setting is NOT "on":
//   on          send
//   off         do not send; nothing went wrong
//   unavailable the setting could not be read; do not send (fail closed) and say so, never a silent guess
// The one exception is a database that does not have the column yet (Postgres 42703, the application deployed ahead of 0373): that
// resolves to the registered default, ON, exactly as an absent value does everywhere else in the settings registry, so shipping the
// code first changes nothing for any studio.

export type NoticeSwitchKey = "send_moved_appointment_emails" | "send_client_cancellation_emails";
export type NoticeSwitchState = "on" | "off" | "unavailable";

const UNDEFINED_COLUMN = "42703";

export async function readNoticeSwitch(
  reader: SupabaseClient,
  studioId: string,
  key: NoticeSwitchKey,
): Promise<NoticeSwitchState> {
  try {
    const { data, error } = await reader.from("studios").select(key).eq("id", studioId).maybeSingle();
    if (error) {
      return (error as { code?: string }).code === UNDEFINED_COLUMN ? defaultState(key) : "unavailable";
    }
    if (!data || typeof data !== "object") return "unavailable";
    const value = (data as Record<string, unknown>)[key];
    // Only a real boolean is a choice. Absent or null is the registered default; anything else is not trusted.
    if (value === undefined || value === null) return defaultState(key);
    if (typeof value !== "boolean") return "unavailable";
    return resolveStudioSetting({ [key]: value }, key) ? "on" : "off";
  } catch {
    return "unavailable";
  }
}

function defaultState(key: NoticeSwitchKey): NoticeSwitchState {
  return STUDIO_SETTINGS[key].default ? "on" : "off";
}
