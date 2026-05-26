import { createClient } from "@/lib/supabase/server";
import type {
  TreatmentPlan,
  TreatmentPlanStage,
} from "@/lib/types/database";

// Plan returned with the count of attached non-deleted sessions. Computed
// per plan via a single follow-up query (one trip, mapped client-side) so
// the page render avoids an N+1 in the list view.
export type TreatmentPlanWithCount = TreatmentPlan & {
  attached_count: number;
};

// Phase C: plan + count + ordered list of treatment schedule stages.
// Stages come from the child table treatment_plan_stages (migration 0034).
// Legacy plans created before Phase C have an empty stages array — the UI
// renders a calm empty state and the plan still works as a simple
// suggested_visit_count target.
export type TreatmentPlanWithStages = TreatmentPlanWithCount & {
  stages: TreatmentPlanStage[];
};

export async function getTreatmentPlansForClient(
  studioId: string,
  clientId: string,
): Promise<TreatmentPlanWithStages[]> {
  const supabase = await createClient();

  const { data: plans, error: plansErr } = await supabase
    .from("treatment_plans")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .order("status", { ascending: true })
    .order("created_at", { ascending: false });
  if (plansErr) throw new Error(`Failed to load plans: ${plansErr.message}`);

  const rows = (plans ?? []) as TreatmentPlan[];
  if (rows.length === 0) return [];

  const ids = rows.map((p) => p.id);

  // Two batched follow-up queries, both keyed on the plan ids. Avoids
  // N+1 on the list view.
  const [sessionsRes, stagesRes] = await Promise.all([
    supabase
      .from("sessions")
      .select("treatment_plan_id")
      .eq("studio_id", studioId)
      .in("treatment_plan_id", ids)
      .is("deleted_at", null),
    supabase
      .from("treatment_plan_stages")
      .select("*")
      .eq("studio_id", studioId)
      .in("plan_id", ids)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true }),
  ]);

  if (sessionsRes.error) {
    throw new Error(`Failed to load plan counts: ${sessionsRes.error.message}`);
  }
  if (stagesRes.error) {
    throw new Error(`Failed to load plan stages: ${stagesRes.error.message}`);
  }

  const counts = new Map<string, number>();
  for (const s of (sessionsRes.data ?? []) as {
    treatment_plan_id: string | null;
  }[]) {
    if (!s.treatment_plan_id) continue;
    counts.set(s.treatment_plan_id, (counts.get(s.treatment_plan_id) ?? 0) + 1);
  }

  const stagesByPlan = new Map<string, TreatmentPlanStage[]>();
  for (const stage of (stagesRes.data ?? []) as TreatmentPlanStage[]) {
    const arr = stagesByPlan.get(stage.plan_id) ?? [];
    arr.push(stage);
    stagesByPlan.set(stage.plan_id, arr);
  }

  return rows.map((p) => ({
    ...p,
    attached_count: counts.get(p.id) ?? 0,
    stages: stagesByPlan.get(p.id) ?? [],
  }));
}

// Active plans only for this client, used by the session detail attach
// widget. Closed plans are not selectable as attach targets.
export async function getActiveTreatmentPlansForClient(
  studioId: string,
  clientId: string,
): Promise<TreatmentPlan[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("treatment_plans")
    .select("*")
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .eq("status", "active")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`Failed to load active plans: ${error.message}`);
  return (data ?? []) as TreatmentPlan[];
}

// Single plan + its current attached count. Used for the banner on the
// session detail page.
export async function getTreatmentPlanWithCount(
  studioId: string,
  planId: string,
): Promise<TreatmentPlanWithCount | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("treatment_plans")
    .select("*")
    .eq("studio_id", studioId)
    .eq("id", planId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load plan: ${error.message}`);
  if (!data) return null;

  const { count, error: countErr } = await supabase
    .from("sessions")
    .select("id", { count: "exact", head: true })
    .eq("studio_id", studioId)
    .eq("treatment_plan_id", planId)
    .is("deleted_at", null);
  if (countErr) {
    throw new Error(`Failed to load plan count: ${countErr.message}`);
  }
  return { ...(data as TreatmentPlan), attached_count: count ?? 0 };
}
