"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { Modality } from "@/lib/types/database";

export async function startSessionAction(formData: FormData): Promise<void> {
  const clientId = formData.get("client_id");
  const modality = formData.get("modality");

  if (typeof clientId !== "string" || !clientId) {
    throw new Error("Missing client id.");
  }
  if (modality !== "electrolysis" && modality !== "laser") {
    throw new Error("Invalid modality.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("sessions")
    .insert({
      studio_id: studio.id,
      client_id: clientId,
      practitioner_id: practitioner.id,
      modality: modality as Modality,
    })
    .select("id")
    .single();

  if (error) {
    throw new Error(`Failed to start session: ${error.message}`);
  }

  revalidatePath(`/clients/${clientId}`);
  redirect(`/clients/${clientId}/sessions/${data.id}`);
}
