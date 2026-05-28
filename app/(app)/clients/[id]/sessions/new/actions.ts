"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { getActiveTreatmentPlansForClient } from "@/lib/treatment-plans/queries";
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
    // Reusing a recent session (coalesce window): leave its treatment_plan_id
    // exactly as-is. Auto-attach only applies to genuinely new sessions, so
    // we never override a plan the practitioner already chose or detached.
    sessionId = existing.id;
  } else {
    // Auto-attach (Session Logging Phase 2), electrolysis-only: treatment
    // plans, schedules, and planned-vs-actual TTT are electrolysis-centered,
    // so auto-attaching a laser session to an active electrolysis plan would
    // be confusing. Laser sessions are therefore never auto-attached (they
    // can still be attached manually on the session page). For an
    // electrolysis session, attach only when the client has exactly one
    // active plan; zero or multiple active plans → leave unattached (the
    // session page's TreatmentPlanAttachment widget shows a chooser for the
    // multiple case). Closed plans never qualify —
    // getActiveTreatmentPlansForClient filters to status='active' and scopes
    // by studio_id + client_id (a foreign client simply yields no plans).
    // No new query/action; reuses the existing helper. treatment_plan_id is
    // the only added insert field.
    let autoPlanId: string | null = null;
    if (modality === "electrolysis") {
      const activePlans = await getActiveTreatmentPlansForClient(
        studio.id,
        clientId,
      );
      if (activePlans.length === 1) autoPlanId = activePlans[0].id;
    }

    const { data, error } = await supabase
      .from("sessions")
      .insert({
        studio_id: studio.id,
        client_id: clientId,
        practitioner_id: practitioner.id,
        performed_by_practitioner_id: practitioner.id,
        modality: modality as Modality,
        treatment_plan_id: autoPlanId,
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
