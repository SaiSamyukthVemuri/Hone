"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { BirthdayReminderColor } from "@/lib/types/database";

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Migration 0040: closed preset list for the birthday reminder accent.
// Validated server-side; an unknown/absent value falls back to 'purple'
// (the column default), never an arbitrary string.
const BIRTHDAY_COLOR_VALUES: ReadonlyArray<BirthdayReminderColor> = [
  "purple",
  "orange",
  "blue",
  "green",
  "neutral",
];
function parseBirthdayColor(
  value: FormDataEntryValue | null,
): BirthdayReminderColor {
  const t = typeof value === "string" ? value.trim() : "";
  return (BIRTHDAY_COLOR_VALUES as ReadonlyArray<string>).includes(t)
    ? (t as BirthdayReminderColor)
    : "purple";
}

export async function updateStudioAction(formData: FormData): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    throw new Error("Only studio owners can change studio settings.");
  }

  const name = nullableString(formData.get("name"));
  if (!name) {
    throw new Error("Studio name is required.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      name,
      legal_entity_name: nullableString(formData.get("legal_entity_name")),
      birthday_reminder_color: parseBirthdayColor(
        formData.get("birthday_reminder_color"),
      ),
    })
    .eq("id", studio.id);

  if (error) {
    throw new Error(`Failed to update studio: ${error.message}`);
  }

  revalidatePath("/dashboard");
  revalidatePath("/settings/studio");
  revalidatePath("/settings/team");
}

export type EmailSettingsResult = { ok: true } | { ok: false; error: string };

function readBool(formData: FormData, key: string): boolean {
  return formData.get(key) === "true";
}

export async function setStudioEmailSettingsAction(
  formData: FormData,
): Promise<EmailSettingsResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (practitioner.role !== "owner") {
    return {
      ok: false,
      error: "Only studio owners can change email settings.",
    };
  }

  // P0 (Blocker 1): the two no-show toggles are server-side force-off
  // for the entire duration of the pre-Stripe hardening pass. A
  // disabled checkbox in the UI is not a security boundary; a crafted
  // server-action POST must not be able to re-enable the unsafe
  // automatic no-show workflow. We literally ignore the submitted
  // form values for these two fields and ALWAYS write `false`. The
  // EmailSettingsForm.tsx UI is wired to match (force-OFF display).
  //
  // This branch removes the toggle's submit pathway entirely. The
  // toggles can be re-enabled in a subsequent migration / branch
  // only after the safe lifecycle redesign (ends_at + grace,
  // claim-token, duplicate-send protection) ships and is approved.
  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      send_confirmation_emails: readBool(formData, "send_confirmation_emails"),
      send_24h_reminders: readBool(formData, "send_24h_reminders"),
      send_2h_reminders: readBool(formData, "send_2h_reminders"),
      auto_mark_no_shows: false,                  // FORCE-OFF (Blocker 1)
      send_no_show_followup: false,               // FORCE-OFF (Blocker 1)
      show_treatment_time_to_clients: readBool(
        formData,
        "show_treatment_time_to_clients",
      ),
    })
    .eq("id", studio.id);
  if (error) {
    console.error(
      JSON.stringify({
        event: "studio_email_settings_update_failed",
        code: error.code,
        message: error.message,
        studioId: studio.id,
        timestamp: new Date().toISOString(),
      }),
    );
    return { ok: false, error: "Could not save settings. Please try again." };
  }

  revalidatePath("/settings/studio");
  return { ok: true };
}
