"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

function trimmedOrThrow(
  value: FormDataEntryValue | null,
  label: string,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required.`);
  }
  return value.trim();
}

export async function updateOwnProfileAction(formData: FormData): Promise<void> {
  const { practitioner } = await getCurrentPractitionerWithStudio();
  const displayName = trimmedOrThrow(
    formData.get("display_name"),
    "Your name",
  );

  const supabase = await createClient();
  const { error } = await supabase
    .from("practitioners")
    .update({ display_name: displayName })
    .eq("id", practitioner.id);
  if (error) {
    throw new Error(`Failed to save your name: ${error.message}`);
  }

  revalidatePath("/settings/profile");
  revalidatePath("/settings/studio");
  revalidatePath("/settings/team");
  revalidatePath("/dashboard");
}
