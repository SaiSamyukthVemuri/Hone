"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { dbErrorCode } from "@/lib/logging/error-class";

// SETTINGS-SMS. The owner-facing switches for the three studio SMS columns
// that already exist (0049) and are already enforced by the send helper and
// the reminder cron. Nothing here sends a message; it only records what the
// owner chose. The send path still requires, per client, a phone number,
// recorded consent and no opt-out, so no setting here can message a client
// who has not agreed (passesConsentGate in lib/sms/send-appointment.ts).

export type SmsSettingsResult = { ok: true } | { ok: false; error: string };

const KEYS = [
  "send_confirmation_sms",
  "send_24h_sms_reminders",
  "send_2h_sms_reminders",
] as const;

export async function setStudioSmsSettingsAction(
  formData: FormData,
): Promise<SmsSettingsResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return { ok: false, error: "Only studio owners can change text message settings." };
  }

  // All three keys must be present and exactly "true" or "false". A crafted
  // or partial submission is refused rather than read as "false", so it can
  // never silently switch another setting off.
  const next: Record<(typeof KEYS)[number], boolean> = {
    send_confirmation_sms: false,
    send_24h_sms_reminders: false,
    send_2h_sms_reminders: false,
  };
  for (const key of KEYS) {
    const raw = formData.get(key);
    if (raw !== "true" && raw !== "false") {
      return { ok: false, error: "Could not save settings. Please try again." };
    }
    next[key] = raw === "true";
  }

  const supabase = await createClient();
  const { error } = await supabase.from("studios").update(next).eq("id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "studio_sms_settings_update_failed",
        code: dbErrorCode(error),
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not save settings. Please try again." };
  }

  revalidatePath("/settings/studio");
  return { ok: true };
}
