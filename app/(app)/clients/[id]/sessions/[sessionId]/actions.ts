"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { validateProbeLotId } from "@/lib/sessions/probe-lot-validation";
import type { ElectrolysisMode } from "@/lib/types/database";
import {
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
  PULSE_DELAY_RANGE_ERROR,
} from "@/lib/constants";

const VALID_MODES: ReadonlyArray<ElectrolysisMode> = ["thermo", "galv", "blend"];

// Pulse delay is recorded only when multiple pulses were done (pulse_count >
// 1); a single-pulse entry stores null. When applicable the value must be in
// [0.03, 1.90] — an out-of-range value throws the same clean message the UI
// shows. Rounded to 2 decimal places.
function resolvePulseDelay(
  value: FormDataEntryValue | null,
  pulseCount: number,
): number | null {
  if (pulseCount <= 1) return null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < PULSE_DELAY_MIN || n > PULSE_DELAY_MAX) {
    throw new Error(PULSE_DELAY_RANGE_ERROR);
  }
  return Math.round(n * 100) / 100;
}

function clampedPulseCount(value: FormDataEntryValue | null): number {
  if (typeof value !== "string" || value.trim() === "") return PULSE_COUNT_DEFAULT;
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return PULSE_COUNT_DEFAULT;
  return Math.min(PULSE_COUNT_MAX, Math.max(PULSE_COUNT_MIN, n));
}

function nullableString(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function nullableNumber(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Non-negative numeric (fractional ok). Out-of-range / invalid → null, matching
// the lenient pickInteger pattern. Used for galvanic_ma and units_of_lye.
function nonNegNumber(value: FormDataEntryValue | null): number | null {
  const n = nullableNumber(value);
  return n != null && n >= 0 ? n : null;
}

// Parses a JSON array of strings from form data and returns trimmed,
// deduplicated, non-empty entries. Falls back to [] for any malformed input.
function parseAreasJson(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string" || value.trim() === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of parsed) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

async function assertSessionVisible(
  studioId: string,
  clientId: string,
  sessionId: string,
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("studio_id", studioId)
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load session: ${error.message}`);
  if (!data) throw new Error("Session not found.");
}

// Migration 0019/0020 plumbing: every electrolysis entry should point at a
// session block. After the 0020 backfill, all pre-existing sessions have a
// "Main" block. For sessions created entirely after 0019 (no entries yet),
// this helper creates the first block on demand using the entry's own
// treatment params as the block's initial values. Once a block exists for
// a session, we never overwrite its params from a later entry (first-write
// semantics). 17.5b.2 UI will surface block creation explicitly; until then
// this stays invisible to the user.
type EnsureBlockParams = {
  studioId: string;
  sessionId: string;
  mode: ElectrolysisMode | null;
  apilusModality: string | null;
  energyLevel: number | null;
  minutesPerformed: number | null;
  probeType: string | null;
  probeSize: string | null;
  machineFrequency: string | null;
};

async function ensureBlockForSession(
  params: EnsureBlockParams,
): Promise<string> {
  const supabase = await createClient();
  const { data: existing, error: lookupErr } = await supabase
    .from("session_blocks")
    .select("id")
    .eq("session_id", params.sessionId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (lookupErr) {
    throw new Error(`Failed to look up session block: ${lookupErr.message}`);
  }
  if (existing) return existing.id;

  const { data: created, error: insertErr } = await supabase
    .from("session_blocks")
    .insert({
      studio_id: params.studioId,
      session_id: params.sessionId,
      sort_order: 1,
      block_name: "Main",
      mode: params.mode,
      apilus_modality: params.apilusModality,
      energy_level: params.energyLevel,
      minutes_performed: params.minutesPerformed,
      probe_type: params.probeType,
      probe_size: params.probeSize,
      machine_frequency: params.machineFrequency,
    })
    .select("id")
    .single();
  if (insertErr || !created) {
    throw new Error(
      `Failed to create session block: ${insertErr?.message ?? "no id returned"}`,
    );
  }
  return created.id;
}

export async function addElectrolysisEntryAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const areas = parseAreasJson(formData.get("areas"));

  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");
  if (areas.length === 0) throw new Error("Area is required.");
  // The legacy `area` column is still NOT NULL in the schema. Migration 0017
  // adds `areas text[]`, but the column stays around for backwards compat
  // until a follow-up migration drops it. Mirror the first array value.
  const area = areas[0];

  const modeRaw = formData.get("mode");
  const mode =
    typeof modeRaw === "string" && VALID_MODES.includes(modeRaw as ElectrolysisMode)
      ? (modeRaw as ElectrolysisMode)
      : null;

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  // Migration 0011: Apilus parameters are now per-entry. Galvanic carries
  // no apilus_modality or energy_level even if the form happens to submit one.
  const apilusModalityRaw = pickEnum(
    formData.get("apilus_modality"),
    APILUS_MODALITY_VALUES,
  );
  const apilusModality = mode === "galv" ? null : apilusModalityRaw;
  const energyLevelRaw = pickInteger(formData.get("energy_level"), {
    min: 0,
  });
  const energyLevel = mode === "galv" ? null : energyLevelRaw;
  const minutesPerformed = pickInteger(formData.get("minutes_performed"), {
    min: 0,
  });
  const probeType = pickEnum(formData.get("probe_type"), PROBE_TYPE_VALUES);
  const machineFrequency = pickEnum(
    formData.get("machine_frequency"),
    MACHINE_FREQUENCY_VALUES,
  );
  const hairsTreated = pickInteger(formData.get("hairs_treated"), { min: 0 });
  const probeSize = nullableString(formData.get("probe_size"));

  // Migration 0042: structured blend / galvanic readings, mode-gated so a
  // thermolysis entry never carries galvanic numbers (and vice versa).
  // Out-of-range values are coerced to null (lenient, like the other
  // numeric fields); the DB CHECK is the final guard.
  const wantGalv = mode === "galv" || mode === "blend";
  const wantThermo = mode === "thermo" || mode === "blend";
  const galvanicMa = wantGalv ? nonNegNumber(formData.get("galvanic_ma")) : null;
  const galvanicDurationSeconds = wantGalv
    ? pickInteger(formData.get("galvanic_duration_seconds"), { min: 0 })
    : null;
  const galvanicIntensityPercent = wantGalv
    ? pickInteger(formData.get("galvanic_intensity_percent"), { min: 0, max: 100 })
    : null;
  const thermolysisIntensityPercent = wantThermo
    ? pickInteger(formData.get("thermolysis_intensity_percent"), {
        min: 0,
        max: 100,
      })
    : null;
  const thermolysisDurationSeconds = wantThermo
    ? pickInteger(formData.get("thermolysis_duration_seconds"), { min: 0 })
    : null;
  const unitsOfLye = wantGalv ? nonNegNumber(formData.get("units_of_lye")) : null;

  // The simplified entry form passes block_id explicitly so multi-block
  // sessions target the correct block. Legacy form callers omit this; for
  // them we look up (or create) the primary block via ensureBlockForSession.
  const explicitBlockId = nullableString(formData.get("block_id"));
  const blockId =
    explicitBlockId ??
    (await ensureBlockForSession({
      studioId: studio.id,
      sessionId,
      mode,
      apilusModality,
      energyLevel,
      minutesPerformed,
      probeType,
      probeSize,
      machineFrequency,
    }));

  const pulseCount = clampedPulseCount(formData.get("pulse_count"));
  const pulseDelaySeconds = resolvePulseDelay(
    formData.get("pulse_delay_seconds"),
    pulseCount,
  );

  const supabase = await createClient();
  // PR 3: never trust a client-supplied probe_lot_id. It must be a well-formed
  // UUID that belongs to THIS studio's probe_lots inventory; otherwise reject.
  // (An absent/free-text lot is fine — probe_lot_number is a separate manual
  // field and is not made "inventory-verified" here.)
  const lotCheck = await validateProbeLotId(
    supabase,
    studio.id,
    nullableString(formData.get("probe_lot_id")),
  );
  if (!lotCheck.ok) throw new Error(lotCheck.error);
  const { error } = await supabase.from("electrolysis_entries").insert({
    session_id: sessionId,
    block_id: blockId,
    area,
    areas,
    probe_size: probeSize,
    probe_lot_id: lotCheck.value,
    mode,
    intensity: nullableNumber(formData.get("intensity")),
    duration_seconds: nullableNumber(formData.get("duration_seconds")),
    pulse_count: pulseCount,
    pulse_delay_seconds: pulseDelaySeconds,
    comments: nullableString(formData.get("comments")),
    apilus_modality: apilusModality,
    energy_level: energyLevel,
    minutes_performed: minutesPerformed,
    probe_type: probeType,
    machine_frequency: machineFrequency,
    hairs_treated: hairsTreated,
    galvanic_ma: galvanicMa,
    galvanic_duration_seconds: galvanicDurationSeconds,
    galvanic_intensity_percent: galvanicIntensityPercent,
    thermolysis_intensity_percent: thermolysisIntensityPercent,
    thermolysis_duration_seconds: thermolysisDurationSeconds,
    units_of_lye: unitsOfLye,
  });

  if (error) throw new Error(`Failed to add entry: ${error.message}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function addLaserEntryAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const zone = nullableString(formData.get("zone"));

  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");
  if (!zone) throw new Error("Zone is required.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const equipmentParams: Record<string, string> = {};
  const fluence = nullableString(formData.get("fluence"));
  const pulseWidth = nullableString(formData.get("pulse_width"));
  const spotSize = nullableString(formData.get("spot_size"));
  if (fluence) equipmentParams.fluence = fluence;
  if (pulseWidth) equipmentParams.pulse_width = pulseWidth;
  if (spotSize) equipmentParams.spot_size = spotSize;

  const sessionNumberRaw = formData.get("session_number");
  const sessionNumber =
    typeof sessionNumberRaw === "string" && sessionNumberRaw.trim() !== ""
      ? parseInt(sessionNumberRaw, 10)
      : null;

  const supabase = await createClient();
  const { error } = await supabase.from("laser_entries").insert({
    session_id: sessionId,
    zone,
    session_number: Number.isFinite(sessionNumber) ? sessionNumber : null,
    equipment_params:
      Object.keys(equipmentParams).length > 0 ? equipmentParams : null,
    observation_notes: nullableString(formData.get("observation_notes")),
  });

  if (error) throw new Error(`Failed to add entry: ${error.message}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

// Migration 0114: a treatment PASS (an electrolysis_entries / laser_entries row)
// is removed by an AUDITED SOFT-DELETE — deleted_at/deleted_by/delete_reason —
// NEVER a hard delete. The clinical record is preserved (and still visible in
// audit/history) but hidden from every active view. This mirrors the
// session_blocks soft-delete pattern (softDeleteSessionBlockAction, 0019). Only
// the selected pass is voided; the block/area, session, appointment, client,
// other passes, and photos are untouched.
async function softDeleteEntry(
  table: "electrolysis_entries" | "laser_entries",
  formData: FormData,
): Promise<void> {
  const id = formData.get("id");
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const rawReason = formData.get("reason");
  if (typeof id !== "string" || !id) throw new Error("Missing entry id.");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");
  // Reason is optional but captured for the audit trail when provided.
  const reason =
    typeof rawReason === "string" && rawReason.trim().length > 0
      ? rawReason.trim()
      : null;

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    throw new Error("Inactive practitioners cannot remove passes.");
  }
  // Verifies the session belongs to THIS studio + client (rejects cross-studio).
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from(table)
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: practitioner.id,
      delete_reason: reason,
    })
    .eq("id", id)
    .eq("session_id", sessionId)
    // Guard: only an ACTIVE pass can be removed — rejects double-void and, with
    // RLS, any entry outside the caller's studio (0 rows updated).
    .is("deleted_at", null)
    .select("id");
  if (error) throw new Error(`Failed to remove pass: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error("This pass has already been removed.");
  }
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteElectrolysisEntryAction(
  formData: FormData,
): Promise<void> {
  await softDeleteEntry("electrolysis_entries", formData);
}

export async function deleteLaserEntryAction(formData: FormData): Promise<void> {
  await softDeleteEntry("laser_entries", formData);
}

export async function updateSessionPriceAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const rawDollars = formData.get("price_dollars");
  let priceCents: number | null;
  if (typeof rawDollars !== "string" || rawDollars.trim() === "") {
    priceCents = null;
  } else {
    const n = Number(rawDollars);
    if (!Number.isFinite(n) || n < 0)
      throw new Error("Price must be a non-negative number.");
    priceCents = Math.round(n * 100);
  }

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("sessions")
    .update({ price_paid_cents: priceCents })
    .eq("id", sessionId)
    .eq("studio_id", studio.id);
  if (error) throw new Error(`Failed to update price: ${error.message}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

// PR #190 (clinical memory, migration 0082). Saves the plan for the
// client's NEXT visit, written while charting this one. Optional;
// empty input clears the note. Surfaced as "From last visit" context
// on the next charting screen and in the previous-session panels.
// PR #191: returns a result instead of throwing so the form can show
// explicit saved / error feedback (Chloe could not tell whether her
// note saved).
export type NextSessionNoteResult =
  | { ok: true; cleared: boolean }
  | { ok: false; error: string };

export async function updateNextSessionNoteAction(
  formData: FormData,
): Promise<NextSessionNoteResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "Missing session." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client." };
  }

  const note = nullableString(formData.get("next_session_note"));

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("sessions")
    .update({ next_session_note: note })
    .eq("id", sessionId)
    .eq("studio_id", studio.id);
  if (error) {
    return { ok: false, error: "Could not save the note. Try again." };
  }
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
  return { ok: true, cleared: note === null };
}

export async function updateSessionPerformerAction(
  formData: FormData,
): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const performerId = formData.get("performer_id");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  // Confirm the chosen practitioner belongs to this studio (RLS already
  // restricts visibility, but a second check guards against tampering).
  const newPerformerId = typeof performerId === "string" && performerId
    ? performerId
    : null;

  if (newPerformerId) {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("practitioners")
      .select("id")
      .eq("id", newPerformerId)
      .eq("studio_id", studio.id)
      .maybeSingle();
    if (error) throw new Error(`Failed to verify practitioner: ${error.message}`);
    if (!data) throw new Error("Practitioner not found in this studio.");
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("sessions")
    .update({ performed_by_practitioner_id: newPerformerId })
    .eq("id", sessionId)
    .eq("studio_id", studio.id);
  if (error) throw new Error(`Failed to update performer: ${error.message}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

export type EditStartedAtResult =
  | { ok: true }
  | { ok: false; error: string };

const APILUS_MODALITY_VALUES = [
  "Multiplex",
  "Microflash",
  "Picoflash",
  "Synchro",
  "Thermoflash",
  "Meloflash",
  "Evolublend",
  "Omniblend",
  "Picoblend",
  "Synchroblend",
  "Multiblend",
] as const;
const PROBE_TYPE_VALUES = [
  "Stainless steel regular",
  "Stainless steel gold",
  "IBL",
  "ITH",
] as const;
const MACHINE_FREQUENCY_VALUES = ["13.56 MHz", "27.12 MHz"] as const;

function pickEnum<T extends string>(
  raw: FormDataEntryValue | null,
  allowed: ReadonlyArray<T>,
): T | null {
  if (typeof raw !== "string" || raw === "") return null;
  return (allowed as ReadonlyArray<string>).includes(raw) ? (raw as T) : null;
}

function pickInteger(
  raw: FormDataEntryValue | null,
  opts: { min?: number; max?: number } = {},
): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return null;
  if (opts.min !== undefined && n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}

export async function editSessionStartedAtAction(
  formData: FormData,
): Promise<EditStartedAtResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const newStartedAtRaw = formData.get("new_started_at");

  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "Missing session id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }
  if (typeof newStartedAtRaw !== "string" || !newStartedAtRaw) {
    return { ok: false, error: "Pick a date and time." };
  }

  const newDate = new Date(newStartedAtRaw);
  if (Number.isNaN(newDate.getTime())) {
    return { ok: false, error: "That isn't a valid date or time." };
  }
  if (newDate.getTime() > Date.now()) {
    return { ok: false, error: "Session time cannot be in the future." };
  }
  const newStartedAtIso = newDate.toISOString();

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit sessions." };
  }

  const supabase = await createClient();

  const { data: existing, error: lookupErr } = await supabase
    .from("sessions")
    .select("id, started_at, ended_at")
    .eq("id", sessionId)
    .eq("studio_id", studio.id)
    .eq("client_id", clientId)
    .maybeSingle();
  if (lookupErr) {
    return { ok: false, error: `Failed to load session: ${lookupErr.message}` };
  }
  if (!existing) {
    return { ok: false, error: "Session not found." };
  }

  if (existing.ended_at) {
    const ended = new Date(existing.ended_at).getTime();
    if (newDate.getTime() > ended) {
      return {
        ok: false,
        error: "Session start cannot be after the session end time.",
      };
    }
  }

  const oldStartedAtIso = existing.started_at;
  if (oldStartedAtIso === newStartedAtIso) {
    return { ok: true };
  }

  const { error: updateErr } = await supabase
    .from("sessions")
    .update({ started_at: newStartedAtIso })
    .eq("id", sessionId)
    .eq("studio_id", studio.id);
  if (updateErr) {
    return {
      ok: false,
      error: `Failed to update session time: ${updateErr.message}`,
    };
  }

  // Audit write happens after the update so the user-visible change has
  // already taken effect. If the audit row fails we log it; the next page
  // render will still show the corrected time, just without an audit entry.
  const { error: auditErr } = await supabase.from("session_audit").insert({
    session_id: sessionId,
    edited_by_practitioner_id: practitioner.id,
    field: "started_at",
    old_value: oldStartedAtIso,
    new_value: newStartedAtIso,
  });
  if (auditErr) {
    console.error("Failed to write session audit row:", auditErr);
  }

  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");

  return { ok: true };
}

export async function softDeleteSessionAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const reasonRaw = formData.get("delete_reason");

  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const reason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  if (reason.length < 10) {
    throw new Error("Reason must be at least 10 characters.");
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    throw new Error("Inactive practitioners cannot delete sessions.");
  }
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("sessions")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: practitioner.id,
      delete_reason: reason,
    })
    .eq("id", sessionId)
    .eq("studio_id", studio.id)
    .is("deleted_at", null);
  if (error) throw new Error(`Failed to delete session: ${error.message}`);

  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");
  redirect(`/clients/${clientId}`);
}
