"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

export type ReviewResult = { ok: true } | { ok: false; error: string };

export async function markIntakeReviewedAction(formData: FormData): Promise<ReviewResult> {
  const intakeId = formData.get("intake_id");
  const clientId = formData.get("client_id");
  const notesRaw = formData.get("practitioner_notes");

  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: "Missing intake id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const notes =
    typeof notesRaw === "string" && notesRaw.trim().length > 0
      ? notesRaw.trim()
      : null;

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot review intakes." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_intake_forms")
    .update({
      status: "reviewed",
      reviewed_at: new Date().toISOString(),
      reviewed_by: practitioner.id,
      practitioner_notes: notes,
    })
    .eq("id", intakeId)
    .eq("studio_id", studio.id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/intake`);
  return { ok: true };
}

export async function saveIntakeNotesAction(formData: FormData): Promise<ReviewResult> {
  const intakeId = formData.get("intake_id");
  const clientId = formData.get("client_id");
  const notesRaw = formData.get("practitioner_notes");
  if (typeof intakeId !== "string" || !intakeId) {
    return { ok: false, error: "Missing intake id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const notes =
    typeof notesRaw === "string" && notesRaw.trim().length > 0
      ? notesRaw.trim()
      : null;

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit intakes." };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("client_intake_forms")
    .update({ practitioner_notes: notes })
    .eq("id", intakeId)
    .eq("studio_id", studio.id)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/clients/${clientId}/intake`);
  return { ok: true };
}
