"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type {
  TreatmentPlanStageHowOftenUnit,
  TreatmentPlanStageLengthUnit,
} from "@/lib/types/database";

const MAX_NAME = 100;
const MAX_VISITS = 200;
// Server-side caps matching the migration 0034 CHECK constraints. Defense
// in depth: RLS + the DB CHECKs already reject bad values, but we surface
// clean errors from the action instead of opaque postgres messages.
const STAGE_NAME_MAX = 80;
const VISIT_LENGTH_MIN = 5;
const VISIT_LENGTH_MAX = 240;
const STAGE_LENGTH_MIN = 1;
const STAGE_LENGTH_MAX = 240;
const GOAL_MINUTES_OVERRIDE_MAX = 60000;
// Body Chart v1 Phase A — matches migration 0038's CHECK.
const PRIMARY_AREA_MAX = 60;
const HOW_OFTEN_VALUES: ReadonlyArray<TreatmentPlanStageHowOftenUnit> = [
  "weekly",
  "every_2_weeks",
  "monthly",
];
const STAGE_LENGTH_UNIT_VALUES: ReadonlyArray<TreatmentPlanStageLengthUnit> = [
  "weeks",
  "months",
];

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

  // Body Chart v1: optional structured area. Empty → null. No value-set
  // validation here — the DB accepts any 1..60 char string, and the UI
  // uses AREA_REGIONS as the canonical picker.
  const primaryAreaRaw = trimmed(formData.get("primary_area"));
  if (primaryAreaRaw.length > PRIMARY_AREA_MAX) {
    return {
      ok: false,
      error: `Primary area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
    };
  }
  const primaryArea = primaryAreaRaw.length === 0 ? null : primaryAreaRaw;

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
    primary_area: primaryArea,
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

// =====================================================================
// Phase C: Treatment schedule (stages) actions + notes editor.
//
// All four new actions follow the existing pattern of this file:
//   - getCurrentPractitionerWithStudio() resolves practitioner + studio
//     server-side; the browser never supplies studio_id
//   - user-scoped createClient() (RLS still applies) — no createAdminClient
//   - validate parent plan ownership before any write
//   - return { ok: true } | { ok: false, error } with sanitized messages
//   - revalidatePath('/clients/[id]') so the page re-renders
//
// The treatment_plan_stages.studio_id column is auto-set by the BEFORE
// INSERT/UPDATE trigger from migration 0034; we still pass it explicitly
// from the verified parent plan so callers cannot accidentally bypass
// the parent check.
// =====================================================================

function parseStageInt(
  value: FormDataEntryValue | null,
  min: number,
  max: number,
): number | null {
  const t = trimmed(value);
  if (!t) return null;
  const n = parseInt(t, 10);
  if (!Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

function isHowOftenUnit(v: string): v is TreatmentPlanStageHowOftenUnit {
  return (HOW_OFTEN_VALUES as ReadonlyArray<string>).includes(v);
}

function isStageLengthUnit(v: string): v is TreatmentPlanStageLengthUnit {
  return (STAGE_LENGTH_UNIT_VALUES as ReadonlyArray<string>).includes(v);
}

// Helper: verify a (plan_id, client_id) pair belongs to the current studio
// and an active plan. Used by every stage-mutating action so the same
// ownership check is not duplicated.
async function verifyPlanForCurrentStudio(
  planId: string,
  clientId: string,
  requireActive: boolean,
): Promise<
  | { ok: true; studioId: string; planStudioId: string }
  | { ok: false; error: string }
> {
  if (!planId) return { ok: false, error: "Missing plan id." };
  if (!clientId) return { ok: false, error: "Missing client id." };

  const { studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();
  const { data: plan, error } = await supabase
    .from("treatment_plans")
    .select("id, status, client_id, studio_id")
    .eq("id", planId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!plan) return { ok: false, error: "Plan not found." };
  if (plan.client_id !== clientId) {
    return { ok: false, error: "Plan does not belong to this client." };
  }
  if (requireActive && plan.status !== "active") {
    return { ok: false, error: "This plan is closed and cannot be edited." };
  }
  return { ok: true, studioId: studio.id, planStudioId: plan.studio_id };
}

export async function updateTreatmentPlanNotesAction(
  formData: FormData,
): Promise<ActionResult> {
  const planId = trimmed(formData.get("plan_id"));
  const clientId = trimmed(formData.get("client_id"));

  const check = await verifyPlanForCurrentStudio(planId, clientId, true);
  if (!check.ok) return check;

  // budget_notes / practitioner_notes: empty string clears the column to
  // null so the UI's "empty textarea" reads as "no notes" rather than as
  // an empty-but-present value.
  const budgetRaw = trimmed(formData.get("budget_notes"));
  const practitionerRaw = trimmed(formData.get("practitioner_notes"));
  const budget = budgetRaw.length === 0 ? null : budgetRaw;
  const practitioner = practitionerRaw.length === 0 ? null : practitionerRaw;

  // Optional override. Empty string clears to null. Out-of-range rejected
  // with a friendly message instead of an opaque CHECK violation.
  const overrideRaw = trimmed(formData.get("treatment_goal_minutes_override"));
  let override: number | null = null;
  if (overrideRaw.length > 0) {
    const parsed = parseStageInt(overrideRaw, 1, GOAL_MINUTES_OVERRIDE_MAX);
    if (parsed == null) {
      return {
        ok: false,
        error: `Estimated total override must be between 1 and ${GOAL_MINUTES_OVERRIDE_MAX} minutes.`,
      };
    }
    override = parsed;
  }

  // Body Chart v1: optional primary area. The field is opt-in for this
  // action — callers that don't include `primary_area` in FormData leave
  // the column untouched. If the field is present, empty becomes null
  // (so a practitioner can clear the area), otherwise the trimmed value
  // is written. No value-set validation here; the canonical list is the
  // UI's responsibility.
  const primaryAreaEntry = formData.get("primary_area");
  const updatePrimaryArea = primaryAreaEntry !== null;
  let primaryArea: string | null = null;
  if (updatePrimaryArea) {
    const trimmedArea = trimmed(primaryAreaEntry);
    if (trimmedArea.length > PRIMARY_AREA_MAX) {
      return {
        ok: false,
        error: `Primary area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
      };
    }
    primaryArea = trimmedArea.length === 0 ? null : trimmedArea;
  }

  const supabase = await createClient();
  const update: {
    budget_notes: string | null;
    practitioner_notes: string | null;
    treatment_goal_minutes_override: number | null;
    primary_area?: string | null;
  } = {
    budget_notes: budget,
    practitioner_notes: practitioner,
    treatment_goal_minutes_override: override,
  };
  if (updatePrimaryArea) update.primary_area = primaryArea;

  const { error } = await supabase
    .from("treatment_plans")
    .update(update)
    .eq("id", planId)
    .eq("studio_id", check.studioId);
  if (error) {
    return { ok: false, error: `Failed to save notes: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function createTreatmentPlanStageAction(
  formData: FormData,
): Promise<ActionResult> {
  const planId = trimmed(formData.get("plan_id"));
  const clientId = trimmed(formData.get("client_id"));

  const check = await verifyPlanForCurrentStudio(planId, clientId, true);
  if (!check.ok) return check;

  const nameRaw = trimmed(formData.get("name"));
  const name = nameRaw.length === 0 ? null : nameRaw;
  if (name && name.length > STAGE_NAME_MAX) {
    return {
      ok: false,
      error: `Stage name must be ${STAGE_NAME_MAX} characters or fewer.`,
    };
  }

  const howOftenRaw = trimmed(formData.get("how_often_unit"));
  if (!isHowOftenUnit(howOftenRaw)) {
    return { ok: false, error: "Pick how often visits should happen." };
  }

  const visitLength = parseStageInt(
    formData.get("visit_length_minutes"),
    VISIT_LENGTH_MIN,
    VISIT_LENGTH_MAX,
  );
  if (visitLength == null) {
    return {
      ok: false,
      error: `Visit length must be between ${VISIT_LENGTH_MIN} and ${VISIT_LENGTH_MAX} minutes.`,
    };
  }

  const stageLengthValue = parseStageInt(
    formData.get("stage_length_value"),
    STAGE_LENGTH_MIN,
    STAGE_LENGTH_MAX,
  );
  if (stageLengthValue == null) {
    return {
      ok: false,
      error: `Stage length must be between ${STAGE_LENGTH_MIN} and ${STAGE_LENGTH_MAX}.`,
    };
  }

  const stageLengthUnitRaw = trimmed(formData.get("stage_length_unit"));
  if (!isStageLengthUnit(stageLengthUnitRaw)) {
    return { ok: false, error: "Pick weeks or months for stage length." };
  }

  const notesRaw = trimmed(formData.get("notes"));
  const notes = notesRaw.length === 0 ? null : notesRaw;

  // sort_order: append to the end. The trigger auto-derives studio_id
  // from the parent plan, but we pass it explicitly anyway so callers
  // see the value they expect; the trigger will overwrite if drift is
  // attempted.
  const supabase = await createClient();
  const { data: maxRow } = await supabase
    .from("treatment_plan_stages")
    .select("sort_order")
    .eq("plan_id", planId)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSortOrder = (maxRow?.sort_order ?? 0) + 1;

  const { error } = await supabase.from("treatment_plan_stages").insert({
    plan_id: planId,
    studio_id: check.planStudioId,
    sort_order: nextSortOrder,
    name,
    how_often_unit: howOftenRaw,
    visit_length_minutes: visitLength,
    stage_length_value: stageLengthValue,
    stage_length_unit: stageLengthUnitRaw,
    notes,
  });
  if (error) {
    return { ok: false, error: `Failed to add stage: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function updateTreatmentPlanStageAction(
  formData: FormData,
): Promise<ActionResult> {
  const stageId = trimmed(formData.get("stage_id"));
  const planId = trimmed(formData.get("plan_id"));
  const clientId = trimmed(formData.get("client_id"));
  if (!stageId) return { ok: false, error: "Missing stage id." };

  const check = await verifyPlanForCurrentStudio(planId, clientId, true);
  if (!check.ok) return check;

  const nameRaw = trimmed(formData.get("name"));
  const name = nameRaw.length === 0 ? null : nameRaw;
  if (name && name.length > STAGE_NAME_MAX) {
    return {
      ok: false,
      error: `Stage name must be ${STAGE_NAME_MAX} characters or fewer.`,
    };
  }

  const howOftenRaw = trimmed(formData.get("how_often_unit"));
  if (!isHowOftenUnit(howOftenRaw)) {
    return { ok: false, error: "Pick how often visits should happen." };
  }

  const visitLength = parseStageInt(
    formData.get("visit_length_minutes"),
    VISIT_LENGTH_MIN,
    VISIT_LENGTH_MAX,
  );
  if (visitLength == null) {
    return {
      ok: false,
      error: `Visit length must be between ${VISIT_LENGTH_MIN} and ${VISIT_LENGTH_MAX} minutes.`,
    };
  }

  const stageLengthValue = parseStageInt(
    formData.get("stage_length_value"),
    STAGE_LENGTH_MIN,
    STAGE_LENGTH_MAX,
  );
  if (stageLengthValue == null) {
    return {
      ok: false,
      error: `Stage length must be between ${STAGE_LENGTH_MIN} and ${STAGE_LENGTH_MAX}.`,
    };
  }

  const stageLengthUnitRaw = trimmed(formData.get("stage_length_unit"));
  if (!isStageLengthUnit(stageLengthUnitRaw)) {
    return { ok: false, error: "Pick weeks or months for stage length." };
  }

  const notesRaw = trimmed(formData.get("notes"));
  const notes = notesRaw.length === 0 ? null : notesRaw;

  const supabase = await createClient();
  const { error } = await supabase
    .from("treatment_plan_stages")
    .update({
      name,
      how_often_unit: howOftenRaw,
      visit_length_minutes: visitLength,
      stage_length_value: stageLengthValue,
      stage_length_unit: stageLengthUnitRaw,
      notes,
    })
    .eq("id", stageId)
    .eq("plan_id", planId)
    .eq("studio_id", check.studioId);
  if (error) {
    return { ok: false, error: `Failed to update stage: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}

export async function deleteTreatmentPlanStageAction(
  formData: FormData,
): Promise<ActionResult> {
  const stageId = trimmed(formData.get("stage_id"));
  const planId = trimmed(formData.get("plan_id"));
  const clientId = trimmed(formData.get("client_id"));
  if (!stageId) return { ok: false, error: "Missing stage id." };

  const check = await verifyPlanForCurrentStudio(planId, clientId, true);
  if (!check.ok) return check;

  const supabase = await createClient();
  const { error } = await supabase
    .from("treatment_plan_stages")
    .delete()
    .eq("id", stageId)
    .eq("plan_id", planId)
    .eq("studio_id", check.studioId);
  if (error) {
    return { ok: false, error: `Failed to remove stage: ${error.message}` };
  }

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
