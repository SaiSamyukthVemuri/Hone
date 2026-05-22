"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
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

  const supabase = await createClient();
  const { error } = await supabase
    .from("studios")
    .update({
      send_confirmation_emails: readBool(formData, "send_confirmation_emails"),
      send_24h_reminders: readBool(formData, "send_24h_reminders"),
      send_2h_reminders: readBool(formData, "send_2h_reminders"),
      auto_mark_no_shows: readBool(formData, "auto_mark_no_shows"),
      send_no_show_followup: readBool(formData, "send_no_show_followup"),
      show_treatment_time_to_clients: readBool(
        formData,
        "show_treatment_time_to_clients",
      ),
    })
    .eq("id", studio.id);
  if (error) return { ok: false, error: error.message };

  revalidatePath("/settings/studio");
  return { ok: true };
}
