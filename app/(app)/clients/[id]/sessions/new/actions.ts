"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { Modality } from "@/lib/types/database";

// Two "+ Log session" taps within this window for the same client +
// practitioner + modality reuse the same session row. Two genuinely
// separate visits (e.g. morning and afternoon) still produce two sessions.
const COALESCE_MINUTES = 90;

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

  const cutoff = new Date(Date.now() - COALESCE_MINUTES * 60 * 1000).toISOString();
  const { data: existing, error: lookupErr } = await supabase
    .from("sessions")
    .select("id")
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .eq("practitioner_id", practitioner.id)
    .eq("modality", modality as Modality)
    .gte("started_at", cutoff)
    .order("started_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up session: ${lookupErr.message}`);
  }

  let sessionId: string;
  if (existing) {
    sessionId = existing.id;
  } else {
    const { data, error } = await supabase
      .from("sessions")
      .insert({
        studio_id: studio.id,
        client_id: clientId,
        practitioner_id: practitioner.id,
        performed_by_practitioner_id: practitioner.id,
        modality: modality as Modality,
      })
      .select("id")
      .single();
    if (error) {
      throw new Error(`Failed to start session: ${error.message}`);
    }
    sessionId = data.id;
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${clientId}/sessions/${sessionId}`);
}
