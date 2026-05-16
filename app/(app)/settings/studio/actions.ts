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
