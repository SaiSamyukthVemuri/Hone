"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";

const MAX_NAME = 100;
const MAX_VISITS = 200;

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function parseVisits(value: FormDataEntryValue | null): number | null {
  const t = trimmed(value);
  if (!t) return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n)) return null;
  if (n < 1 || n > MAX_VISITS) return null;
  return n;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createTreatmentPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const clientId = trimmed(formData.get("client_id"));
  const name = trimmed(formData.get("name"));
  const suggested = parseVisits(formData.get("suggested_visit_count"));

  if (!clientId) return { ok: false, error: "Missing client id." };
  if (!name) return { ok: false, error: "Plan name is required." };
  if (name.length > MAX_NAME) {
    return { ok: false, error: `Plan name must be ${MAX_NAME} characters or fewer.` };
  }
  if (suggested == null) {
    return {
      ok: false,
      error: `Suggested visit count must be between 1 and ${MAX_VISITS}.`,
    };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Verify client belongs to this studio. RLS guards this too; double-
  // check here for a cleaner error than an opaque RLS failure.
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) return { ok: false, error: clientErr.message };
  if (!client) return { ok: false, error: "Client not found." };

  const { error } = await supabase.from("treatment_plans").insert({
    client_id: clientId,
    studio_id: studio.id,
    name,
    suggested_visit_count: suggested,
    status: "active",
    created_by_practitioner_id: practitioner.id,
  });
  if (error) return { ok: false, error: `Failed to create plan: ${error.message}` };

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function closeTreatmentPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const planId = trimmed(formData.get("plan_id"));
  const clientId = trimmed(formData.get("client_id"));
  if (!planId) return { ok: false, error: "Missing plan id." };
  if (!clientId) return { ok: false, error: "Missing client id." };

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  const { error } = await supabase
    .from("treatment_plans")
    .update({
      status: "closed",
      closed_at: new Date().toISOString(),
      closed_by_practitioner_id: practitioner.id,
    })
    .eq("id", planId)
    .eq("studio_id", studio.id)
    .eq("status", "active");
  if (error) return { ok: false, error: `Failed to close plan: ${error.message}` };

  revalidatePath(`/clients/${clientId}`);
  // The attached sessions' banners need to flip from amber to neutral.
  revalidatePath(`/clients/${clientId}/sessions`);
  return { ok: true };
}

export async function attachChartEntryToPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const sessionId = trimmed(formData.get("session_id"));
  const planId = trimmed(formData.get("plan_id"));
  const clientId = trimmed(formData.get("client_id"));
  if (!sessionId) return { ok: false, error: "Missing session id." };
  if (!planId) return { ok: false, error: "Missing plan id." };
  if (!clientId) return { ok: false, error: "Missing client id." };

  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Verify the plan belongs to this studio and is still attachable
  // (active). Attaching to a closed plan is a UI mistake we reject here.
  const { data: plan, error: planErr } = await supabase
    .from("treatment_plans")
    .select("id, status, client_id")
    .eq("id", planId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (planErr) return { ok: false, error: planErr.message };
  if (!plan) return { ok: false, error: "Plan not found." };
  if (plan.status !== "active") {
    return { ok: false, error: "Cannot attach to a closed plan." };
  }
  if (plan.client_id !== clientId) {
    return { ok: false, error: "Plan does not belong to this client." };
  }

  const { error } = await supabase
    .from("sessions")
    .update({ treatment_plan_id: planId })
    .eq("id", sessionId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) {
    return { ok: false, error: `Failed to attach session: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  return { ok: true };
}

export async function detachChartEntryFromPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const sessionId = trimmed(formData.get("session_id"));
  const clientId = trimmed(formData.get("client_id"));
  if (!sessionId) return { ok: false, error: "Missing session id." };
  if (!clientId) return { ok: false, error: "Missing client id." };

  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Detach is allowed regardless of the attached plan's status.
  const { error } = await supabase
    .from("sessions")
    .update({ treatment_plan_id: null })
    .eq("id", sessionId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId);
  if (error) {
    return { ok: false, error: `Failed to detach session: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  return { ok: true };
}
