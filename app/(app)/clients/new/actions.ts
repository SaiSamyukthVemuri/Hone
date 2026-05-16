"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function nullableInt(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : null;
}

export async function createClientAction(formData: FormData): Promise<void> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();

  const name = nullableString(formData.get("name"));
  if (!name) {
    throw new Error("Name is required.");
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clients")
    .insert({
      studio_id: studio.id,
      name,
      pronouns: nullableString(formData.get("pronouns")),
      phone: nullableString(formData.get("phone")),
      email: nullableString(formData.get("email")),
      date_of_birth: nullableString(formData.get("date_of_birth")),
      fitzpatrick_type: nullableInt(formData.get("fitzpatrick_type")),
      skin_notes: nullableString(formData.get("skin_notes")),
      created_by: practitioner.id,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to create client: ${error.message}`);
  }

  revalidatePath("/clients");
  revalidatePath("/dashboard");
  redirect(`/clients/${data.id}`);
}
