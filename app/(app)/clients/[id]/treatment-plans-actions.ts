"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type {
  TreatmentPlanStageHowOftenUnit,
  TreatmentPlanStageLengthUnit,
} from "@/lib/types/database";
import { DEFAULT_PLAN_STAGES } from "@/lib/treatment-plans/stage-defaults";

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
// Multi-area + timeline caps that match migration 0051 CHECK constraints.
const TREATMENT_AREAS_MAX = 12;
const TIMELINE_MONTHS_MIN = 1;
const TIMELINE_MONTHS_MAX = 60;
// Default Estimated visits to write when the new create UI omits it.
// Matches the column default added in migration 0051 (we send it
// explicitly so an older Postgres connection pool with stale schema
// metadata still inserts a valid row).
const DEFAULT_SUGGESTED_VISIT_COUNT = 12;
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

// Multi-area writers: read every FormData value keyed `treatment_areas`
// (repeated keys, one per selected area), trim, drop empties, dedupe
// in order, and cap at TREATMENT_AREAS_MAX. Returns:
//   - { ok: true, value: null }       → no field was sent; caller should
//                                        leave the column untouched
//   - { ok: true, value: string[] }   → field was sent (may be empty
//                                        array to mean "clear all areas")
//   - { ok: false, error }            → a value was malformed
function parseTreatmentAreasFromFormData(
  formData: FormData,
):
  | { ok: true; value: string[] | null }
  | { ok: false; error: string } {
  // formData.has() is the only way to tell "field omitted" from
  // "field sent empty"; we need that distinction so partial form posts
  // (e.g. the notes editor that only edits notes) don't clobber the
  // existing areas array.
  if (!formData.has("treatment_areas")) {
    return { ok: true, value: null };
  }
  const raw = formData
    .getAll("treatment_areas")
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v.length > 0);

  for (const v of raw) {
    if (v.length > PRIMARY_AREA_MAX) {
      return {
        ok: false,
        error: `Each treatment area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
      };
    }
  }

  // Dedupe in insertion order so the first occurrence wins (matters
  // because areas[0] mirrors into primary_area).
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const v of raw) {
    if (seen.has(v)) continue;
    seen.add(v);
    deduped.push(v);
  }

  if (deduped.length > TREATMENT_AREAS_MAX) {
    return {
      ok: false,
      error: `A plan can cover at most ${TREATMENT_AREAS_MAX} areas.`,
    };
  }

  return { ok: true, value: deduped };
}

// Timeline months parser. Each field is optional; an empty input
// becomes null. Out-of-range returns a friendly error. Caller is
// responsible for cross-field ordering checks (min <= max).
function parseTimelineMonths(
  value: FormDataEntryValue | null,
):
  | { ok: true; value: number | null }
  | { ok: false; error: string } {
  const t = trimmed(value);
  if (!t) return { ok: true, value: null };
  const n = parseInt(t, 10);
  if (!Number.isFinite(n) || n < TIMELINE_MONTHS_MIN || n > TIMELINE_MONTHS_MAX) {
    return {
      ok: false,
      error: `Timeline months must be between ${TIMELINE_MONTHS_MIN} and ${TIMELINE_MONTHS_MAX}.`,
    };
  }
  return { ok: true, value: n };
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function createTreatmentPlanAction(
  formData: FormData,
): Promise<ActionResult> {
  const clientId = trimmed(formData.get("client_id"));
  const name = trimmed(formData.get("name"));

  if (!clientId) return { ok: false, error: "Missing client id." };
  if (!name) return { ok: false, error: "Plan name is required." };
  if (name.length > MAX_NAME) {
    return { ok: false, error: `Plan name must be ${MAX_NAME} characters or fewer.` };
  }

  // Estimated visits is no longer required from the new create UI:
  // Chloe's reframing makes it a legacy/secondary field. If the form
  // does send a value we honour it for backward compatibility; if it
  // is omitted or invalid we fall back to the column default added in
  // migration 0051 so insert always succeeds with a sensible row.
  const suggestedFromForm = parseVisits(formData.get("suggested_visit_count"));
  const suggested = suggestedFromForm ?? DEFAULT_SUGGESTED_VISIT_COUNT;

  // Backward-compatible single primary_area read, kept so older form
  // posts still work. The multi-area parser below takes precedence and
  // overwrites primary_area with treatment_areas[0] when present.
  const primaryAreaRaw = trimmed(formData.get("primary_area"));
  if (primaryAreaRaw.length > PRIMARY_AREA_MAX) {
    return {
      ok: false,
      error: `Primary area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
    };
  }

  // Multi-area: read repeated `treatment_areas` form fields. Dedupes
  // and caps at TREATMENT_AREAS_MAX. The first element mirrors into
  // primary_area for backward compatibility with the session-area
  // defaulting, banner fallback, and data export.
  const areasParsed = parseTreatmentAreasFromFormData(formData);
  if (!areasParsed.ok) return { ok: false, error: areasParsed.error };

  let treatmentAreas: string[] | null;
  let primaryArea: string | null;
  if (areasParsed.value !== null) {
    treatmentAreas = areasParsed.value.length === 0 ? null : areasParsed.value;
    primaryArea =
      treatmentAreas != null && treatmentAreas.length > 0
        ? treatmentAreas[0]
        : primaryAreaRaw.length === 0
          ? null
          : primaryAreaRaw;
  } else {
    treatmentAreas = null;
    primaryArea = primaryAreaRaw.length === 0 ? null : primaryAreaRaw;
  }

  // Timeline months. Both sides optional and validated independently;
  // cross-field ordering (min <= max) checked after.
  const tlMinParsed = parseTimelineMonths(
    formData.get("estimated_timeline_months_min"),
  );
  if (!tlMinParsed.ok) return { ok: false, error: tlMinParsed.error };
  const tlMaxParsed = parseTimelineMonths(
    formData.get("estimated_timeline_months_max"),
  );
  if (!tlMaxParsed.ok) return { ok: false, error: tlMaxParsed.error };
  if (
    tlMinParsed.value != null &&
    tlMaxParsed.value != null &&
    tlMinParsed.value > tlMaxParsed.value
  ) {
    return {
      ok: false,
      error: "Timeline from-months must be less than or equal to to-months.",
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

  const { data: createdPlan, error } = await supabase
    .from("treatment_plans")
    .insert({
      client_id: clientId,
      studio_id: studio.id,
      name,
      suggested_visit_count: suggested,
      status: "active",
      created_by_practitioner_id: practitioner.id,
      primary_area: primaryArea,
      treatment_areas: treatmentAreas,
      estimated_timeline_months_min: tlMinParsed.value,
      estimated_timeline_months_max: tlMaxParsed.value,
    })
    .select("id")
    .single();
  if (error || !createdPlan) {
    return {
      ok: false,
      error: `Failed to create plan: ${error?.message ?? "unknown error"}`,
    };
  }

  // Seed the fixed clinical stages every new plan starts with: Clearing,
  // Control, Maintenance (sort_order 1/2/3), with generic, fully-editable
  // defaults. The schedule editor renders these as locked-label cards. The
  // child table's BEFORE trigger derives studio_id from the parent plan; we
  // pass it explicitly to match the existing stage-insert pattern.
  const stageRows = DEFAULT_PLAN_STAGES.map((s, i) => ({
    plan_id: createdPlan.id,
    studio_id: studio.id,
    sort_order: i + 1,
    name: s.name,
    how_often_unit: s.howOftenUnit,
    visit_length_minutes: s.visitLengthMinutes,
    stage_length_value: s.stageLengthValue,
    stage_length_unit: s.stageLengthUnit,
    notes: null,
  }));
  const { error: stagesErr } = await supabase
    .from("treatment_plan_stages")
    .insert(stageRows);
  if (stagesErr) {
    // Best-effort cleanup so a stage-insert failure doesn't leave a confusing
    // stageless plan behind. Same user-scoped client + RLS; no admin/RPC.
    await supabase.from("treatment_plans").delete().eq("id", createdPlan.id);
    return {
      ok: false,
      error: `Failed to set up plan stages: ${stagesErr.message}`,
    };
  }

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

  // Multi-area: opt-in update. When the form does not include
  // `treatment_areas` we leave both treatment_areas and primary_area
  // untouched (the notes editor that only edits prose, for example,
  // should not clobber a careful area selection from the create form).
  // When the form does include treatment_areas, the parsed list is the
  // authoritative source: empty → null on both columns; non-empty →
  // store the list and mirror areas[0] into primary_area for backward
  // compatibility with the session area defaulting, banner fallback,
  // and data export.
  //
  // The legacy single-field `primary_area` is still honoured when the
  // form sends it WITHOUT a treatment_areas key (older edit surfaces or
  // partial form posts) so the column stays editable without a
  // multi-area picker.
  const areasParsed = parseTreatmentAreasFromFormData(formData);
  if (!areasParsed.ok) return { ok: false, error: areasParsed.error };

  let updateTreatmentAreas = false;
  let updatePrimaryArea = false;
  let nextTreatmentAreas: string[] | null = null;
  let nextPrimaryArea: string | null = null;

  if (areasParsed.value !== null) {
    updateTreatmentAreas = true;
    updatePrimaryArea = true;
    nextTreatmentAreas =
      areasParsed.value.length === 0 ? null : areasParsed.value;
    nextPrimaryArea =
      nextTreatmentAreas != null && nextTreatmentAreas.length > 0
        ? nextTreatmentAreas[0]
        : null;
  } else {
    const primaryAreaEntry = formData.get("primary_area");
    if (primaryAreaEntry !== null) {
      updatePrimaryArea = true;
      const trimmedArea = trimmed(primaryAreaEntry);
      if (trimmedArea.length > PRIMARY_AREA_MAX) {
        return {
          ok: false,
          error: `Primary area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
        };
      }
      nextPrimaryArea = trimmedArea.length === 0 ? null : trimmedArea;
    }
  }

  // Timeline months: each side is independently opt-in. We only set a
  // column when its form field is explicitly present; an absent field
  // leaves the column untouched. An empty value with the field present
  // clears the column to null.
  const tlMinEntry = formData.get("estimated_timeline_months_min");
  const tlMaxEntry = formData.get("estimated_timeline_months_max");
  const updateTimelineMin = tlMinEntry !== null;
  const updateTimelineMax = tlMaxEntry !== null;
  let nextTimelineMin: number | null = null;
  let nextTimelineMax: number | null = null;
  if (updateTimelineMin) {
    const parsedMin = parseTimelineMonths(tlMinEntry);
    if (!parsedMin.ok) return { ok: false, error: parsedMin.error };
    nextTimelineMin = parsedMin.value;
  }
  if (updateTimelineMax) {
    const parsedMax = parseTimelineMonths(tlMaxEntry);
    if (!parsedMax.ok) return { ok: false, error: parsedMax.error };
    nextTimelineMax = parsedMax.value;
  }
  // Cross-field ordering check: only meaningful when both sides are
  // being written in this request. If only one is being updated, the
  // DB's CHECK guards the cross-field invariant against the
  // not-being-touched persisted value.
  if (
    updateTimelineMin &&
    updateTimelineMax &&
    nextTimelineMin != null &&
    nextTimelineMax != null &&
    nextTimelineMin > nextTimelineMax
  ) {
    return {
      ok: false,
      error: "Timeline from-months must be less than or equal to to-months.",
    };
  }

  const supabase = await createClient();
  const update: {
    budget_notes: string | null;
    practitioner_notes: string | null;
    treatment_goal_minutes_override: number | null;
    primary_area?: string | null;
    treatment_areas?: string[] | null;
    estimated_timeline_months_min?: number | null;
    estimated_timeline_months_max?: number | null;
  } = {
    budget_notes: budget,
    practitioner_notes: practitioner,
    treatment_goal_minutes_override: override,
  };
  if (updateTreatmentAreas) update.treatment_areas = nextTreatmentAreas;
  if (updatePrimaryArea) update.primary_area = nextPrimaryArea;
  if (updateTimelineMin) {
    update.estimated_timeline_months_min = nextTimelineMin;
  }
  if (updateTimelineMax) {
    update.estimated_timeline_months_max = nextTimelineMax;
  }

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
