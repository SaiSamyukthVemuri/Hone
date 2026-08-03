"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { isValidProbeOptionKey } from "@/lib/probes";

// PR #205 (migration 0085): record-keeping server actions. All
// practitioner-authenticated; studio_id always resolved server-side
// from the session, never from the form. Writes go through the
// user-scoped supabase client so is_studio_member RLS enforces studio
// isolation end to end. No payment, auth, or public surface.

export type RecordActionResult = { ok: true } | { ok: false; error: string };

const GENERIC_ERROR = "Couldn't save this record. Please try again.";

function str(v: FormDataEntryValue | null, max = 2000): string {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

// Migration 0155: an optional structured probe classification on a sterile item.
// Empty = clears to NULL. A non-empty value MUST validate against the code
// catalog (lib/probes.ts) — an arbitrary client-supplied key is rejected. We
// never infer probe_key from item_description.
function resolveProbeKeyField(
  formData: FormData,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const raw = str(formData.get("probe_key"), 120);
  if (!raw) return { ok: true, value: null };
  if (!isValidProbeOptionKey(raw)) {
    return { ok: false, error: "That probe selection is not recognized." };
  }
  return { ok: true, value: raw };
}

// "YYYY-MM-DD" or empty. Bad input becomes empty (treated as missing).
function dateStr(v: FormDataEntryValue | null): string {
  const s = str(v, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : "";
}

// PR #280: resolve the disinfectant operator from the dropdown. A selected
// same-studio active practitioner wins (the display name is resolved
// server-side, so it stays accurate); otherwise it is a free-text "Other"
// operator (falling back to the current user's name when left blank). The
// practitioner lookup is studio-scoped + RLS-guarded, so a cross-studio id can
// never attach — it simply falls through to the free-text path.
const OTHER_OPERATOR = "__other__";

async function resolveOperator(
  supabase: Awaited<ReturnType<typeof createClient>>,
  studioId: string,
  formData: FormData,
  fallbackName: string,
): Promise<{ operator_practitioner_id: string | null; operator_name: string }> {
  const selId = str(formData.get("operator_practitioner_id"), 60);
  if (selId && selId !== OTHER_OPERATOR) {
    const { data } = await supabase
      .from("practitioners")
      .select("id, display_name, email")
      .eq("id", selId)
      .eq("studio_id", studioId)
      .eq("active", true)
      .maybeSingle();
    if (data) {
      return {
        operator_practitioner_id: data.id as string,
        operator_name:
          (data.display_name as string | null)?.trim() || (data.email as string),
      };
    }
  }
  return {
    operator_practitioner_id: null,
    operator_name: str(formData.get("operator_name"), 200) || fallbackName,
  };
}

export async function addSterileItemRecordAction(
  formData: FormData,
): Promise<RecordActionResult> {
  let practitionerId: string, studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  const datePurchased = dateStr(formData.get("date_purchased"));
  const itemDescription = str(formData.get("item_description"), 300);
  if (!datePurchased || !itemDescription) {
    return {
      ok: false,
      error: "Date purchased and item description are required.",
    };
  }
  const expiry = dateStr(formData.get("expiry_date"));
  const probeKey = resolveProbeKeyField(formData);
  if (!probeKey.ok) return probeKey;
  const supabase = await createClient();
  const { error } = await supabase.from("record_keeping_sterile_items").insert({
    studio_id: studioId,
    date_purchased: datePurchased,
    item_description: itemDescription,
    manufacturer_name: str(formData.get("manufacturer_name"), 200),
    amount_purchased: str(formData.get("amount_purchased"), 100),
    lot_number: str(formData.get("lot_number"), 120),
    expiry_date: expiry || null,
    notes: str(formData.get("notes")) || null,
    probe_key: probeKey.value,
    created_by_practitioner_id: practitionerId,
  });
  if (error) return { ok: false, error: GENERIC_ERROR };
  revalidatePath("/records");
  return { ok: true };
}

export async function addDisinfectantRecordAction(
  formData: FormData,
): Promise<RecordActionResult> {
  let practitionerId: string, studioId: string, operatorFallback: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
    operatorFallback = practitioner.display_name?.trim() || practitioner.email;
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  const datePrepared = dateStr(formData.get("date_prepared"));
  const name = str(formData.get("disinfectant_name"), 200);
  if (!datePrepared || !name) {
    return {
      ok: false,
      error: "Date prepared and disinfectant name are required.",
    };
  }
  const discarded = dateStr(formData.get("date_discarded"));
  // PR #280: distinct "discard / replace by" date drives the read-time alert.
  const discardDue = dateStr(formData.get("discard_due_date"));
  const supabase = await createClient();
  const operator = await resolveOperator(
    supabase,
    studioId,
    formData,
    operatorFallback,
  );
  const { error } = await supabase
    .from("record_keeping_disinfectants")
    .insert({
      studio_id: studioId,
      date_prepared: datePrepared,
      disinfectant_name: name,
      concentration: str(formData.get("concentration"), 100),
      discard_due_date: discardDue || null,
      date_discarded: discarded || null,
      // PR #280: operator from the same-studio dropdown (or free-text "Other").
      operator_practitioner_id: operator.operator_practitioner_id,
      operator_name: operator.operator_name,
      notes: str(formData.get("notes")) || null,
      created_by_practitioner_id: practitionerId,
    });
  if (error) return { ok: false, error: GENERIC_ERROR };
  revalidatePath("/records");
  return { ok: true };
}

export async function addExposureIncidentRecordAction(
  formData: FormData,
): Promise<RecordActionResult> {
  let practitionerId: string, studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    practitionerId = practitioner.id;
    studioId = studio.id;
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  const incidentDate = dateStr(formData.get("incident_date"));
  const exposedName = str(formData.get("exposed_person_full_name"), 200);
  if (!incidentDate || !exposedName) {
    return {
      ok: false,
      error: "Incident date and the exposed person's full name are required.",
    };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("record_keeping_exposure_incidents")
    .insert({
      studio_id: studioId,
      incident_date: incidentDate,
      exposed_person_full_name: exposedName,
      exposed_person_address: str(formData.get("exposed_person_address"), 400),
      exposed_person_phone: str(formData.get("exposed_person_phone"), 60),
      exposure_details: str(formData.get("exposure_details")),
      action_taken: str(formData.get("action_taken")),
      staff_involved_name: str(formData.get("staff_involved_name"), 200),
      notes: str(formData.get("notes")) || null,
      created_by_practitioner_id: practitionerId,
    });
  if (error) return { ok: false, error: GENERIC_ERROR };
  revalidatePath("/records");
  return { ok: true };
}

// Explicit, practitioner-marked "procedure risks explained and
// aftercare information provided" stamp for the client procedure
// record. Never auto-set; this action is the ONLY writer. Toggling
// off clears the stamp (a mis-tap must be reversible).
export async function markAftercareExplainedAction(
  formData: FormData,
): Promise<RecordActionResult> {
  // The stamping practitioner and the studio are now derived inside the command
  // from auth.uid(); this call remains as the AUTH GATE, so an unauthenticated
  // or non-member caller still gets the generic error here, exactly as before.
  try {
    await getCurrentPractitionerWithStudio();
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  const sessionId = str(formData.get("session_id"), 60);
  // Require EXPLICIT intent. Previously any value other than "true" (including a
  // missing/garbage field) silently CLEARED the stamp; now only the literal
  // "true"/"false" set/clear it, and anything else is rejected without a write.
  const explainedRaw = str(formData.get("explained"), 10);
  if (explainedRaw !== "true" && explainedRaw !== "false") {
    return { ok: false, error: GENERIC_ERROR };
  }
  const explained = explainedRaw === "true";
  if (!sessionId) return { ok: false, error: GENERIC_ERROR };
  const supabase = await createClient();
  // L18 Phase 3: both columns are set or cleared together inside
  // set_session_aftercare_explained (migration 0167), and the stamping
  // practitioner is derived from auth.uid() rather than sent by the caller.
  const { error } = await supabase.rpc("set_session_aftercare_explained", {
    p_session_id: sessionId,
    p_explained: explained,
  });
  if (error) return { ok: false, error: GENERIC_ERROR };
  revalidatePath("/records");
  return { ok: true };
}

// PR #206: edit support for the three logbooks. Same auth/validation
// posture as the add actions; updates go through the user-scoped
// client (RLS UPDATE policy enforces studio membership) and the 0086
// triggers write the audit event with the changed-field diff. No
// delete action exists anywhere in this module, by design.

export async function updateSterileItemRecordAction(
  formData: FormData,
): Promise<RecordActionResult> {
  let studioId: string;
  try {
    const { studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  const recordId = str(formData.get("record_id"), 60);
  const datePurchased = dateStr(formData.get("date_purchased"));
  const itemDescription = str(formData.get("item_description"), 300);
  if (!recordId || !datePurchased || !itemDescription) {
    return {
      ok: false,
      error: "Date purchased and item description are required.",
    };
  }
  const expiry = dateStr(formData.get("expiry_date"));
  const probeKey = resolveProbeKeyField(formData);
  if (!probeKey.ok) return probeKey;
  const supabase = await createClient();
  const { error } = await supabase
    .from("record_keeping_sterile_items")
    .update({
      date_purchased: datePurchased,
      item_description: itemDescription,
      manufacturer_name: str(formData.get("manufacturer_name"), 200),
      amount_purchased: str(formData.get("amount_purchased"), 100),
      lot_number: str(formData.get("lot_number"), 120),
      expiry_date: expiry || null,
      notes: str(formData.get("notes")) || null,
      probe_key: probeKey.value,
    })
    .eq("id", recordId)
    .eq("studio_id", studioId);
  if (error) return { ok: false, error: GENERIC_ERROR };
  revalidatePath("/records");
  return { ok: true };
}

export async function updateDisinfectantRecordAction(
  formData: FormData,
): Promise<RecordActionResult> {
  let studioId: string, operatorFallback: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    studioId = studio.id;
    operatorFallback = practitioner.display_name?.trim() || practitioner.email;
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  const recordId = str(formData.get("record_id"), 60);
  const datePrepared = dateStr(formData.get("date_prepared"));
  const name = str(formData.get("disinfectant_name"), 200);
  if (!recordId || !datePrepared || !name) {
    return {
      ok: false,
      error: "Date prepared and disinfectant name are required.",
    };
  }
  const discarded = dateStr(formData.get("date_discarded"));
  const discardDue = dateStr(formData.get("discard_due_date"));
  const supabase = await createClient();
  // PR #280: edits now also (re)write the operator FK from the dropdown.
  const operator = await resolveOperator(
    supabase,
    studioId,
    formData,
    operatorFallback,
  );
  const { error } = await supabase
    .from("record_keeping_disinfectants")
    .update({
      date_prepared: datePrepared,
      disinfectant_name: name,
      concentration: str(formData.get("concentration"), 100),
      discard_due_date: discardDue || null,
      date_discarded: discarded || null,
      operator_practitioner_id: operator.operator_practitioner_id,
      operator_name: operator.operator_name,
      notes: str(formData.get("notes")) || null,
    })
    .eq("id", recordId)
    .eq("studio_id", studioId);
  if (error) return { ok: false, error: GENERIC_ERROR };
  revalidatePath("/records");
  return { ok: true };
}

export async function updateExposureIncidentRecordAction(
  formData: FormData,
): Promise<RecordActionResult> {
  let studioId: string;
  try {
    const { practitioner, studio } = await getCurrentPractitionerWithStudio();
    // PR #222: editing exposure incidents is owner-only. RLS
    // (migration 0088) is the backstop; this check exists so a
    // non-owner gets an honest error instead of a silent no-op.
    if (practitioner.role !== "owner") {
      return {
        ok: false,
        error: "Exposure incident history is owner-only.",
      };
    }
    studioId = studio.id;
  } catch {
    return { ok: false, error: GENERIC_ERROR };
  }
  const recordId = str(formData.get("record_id"), 60);
  const incidentDate = dateStr(formData.get("incident_date"));
  const exposedName = str(formData.get("exposed_person_full_name"), 200);
  if (!recordId || !incidentDate || !exposedName) {
    return {
      ok: false,
      error: "Incident date and the exposed person's full name are required.",
    };
  }
  const supabase = await createClient();
  const { error } = await supabase
    .from("record_keeping_exposure_incidents")
    .update({
      incident_date: incidentDate,
      exposed_person_full_name: exposedName,
      exposed_person_address: str(formData.get("exposed_person_address"), 400),
      exposed_person_phone: str(formData.get("exposed_person_phone"), 60),
      exposure_details: str(formData.get("exposure_details")),
      action_taken: str(formData.get("action_taken")),
      staff_involved_name: str(formData.get("staff_involved_name"), 200),
      notes: str(formData.get("notes")) || null,
    })
    .eq("id", recordId)
    .eq("studio_id", studioId);
  if (error) return { ok: false, error: GENERIC_ERROR };
  revalidatePath("/records");
  return { ok: true };
}
