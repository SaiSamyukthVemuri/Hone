"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { ElectrolysisMode } from "@/lib/types/database";
import {
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
} from "@/lib/constants";

const VALID_MODES: ReadonlyArray<ElectrolysisMode> = ["thermo", "galv", "blend"];

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

export async function addElectrolysisEntryAction(formData: FormData): Promise<void> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  const area = nullableString(formData.get("area"));

  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");
  if (!area) throw new Error("Area is required.");

  const modeRaw = formData.get("mode");
  const mode =
    typeof modeRaw === "string" && VALID_MODES.includes(modeRaw as ElectrolysisMode)
      ? (modeRaw as ElectrolysisMode)
      : null;

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase.from("electrolysis_entries").insert({
    session_id: sessionId,
    area,
    probe_size: nullableString(formData.get("probe_size")),
    probe_lot_id: nullableString(formData.get("probe_lot_id")),
    mode,
    intensity: nullableNumber(formData.get("intensity")),
    duration_seconds: nullableNumber(formData.get("duration_seconds")),
    pulse_count: clampedPulseCount(formData.get("pulse_count")),
    comments: nullableString(formData.get("comments")),
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

export async function deleteElectrolysisEntryAction(
  formData: FormData,
): Promise<void> {
  const id = formData.get("id");
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  if (typeof id !== "string" || !id) throw new Error("Missing entry id.");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("electrolysis_entries")
    .delete()
    .eq("id", id)
    .eq("session_id", sessionId);
  if (error) throw new Error(`Failed to delete entry: ${error.message}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
}

export async function deleteLaserEntryAction(formData: FormData): Promise<void> {
  const id = formData.get("id");
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  if (typeof id !== "string" || !id) throw new Error("Missing entry id.");
  if (typeof sessionId !== "string" || !sessionId) throw new Error("Missing session.");
  if (typeof clientId !== "string" || !clientId) throw new Error("Missing client.");

  const { studio } = await getCurrentPractitionerWithStudio();
  await assertSessionVisible(studio.id, clientId, sessionId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("laser_entries")
    .delete()
    .eq("id", id)
    .eq("session_id", sessionId);
  if (error) throw new Error(`Failed to delete entry: ${error.message}`);
  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
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

export type TreatmentParamsResult =
  | { ok: true }
  | { ok: false; error: string };

const ELECTROLYSIS_MODE_VALUES = ["thermo", "blend", "galv"] as const;
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
const PROBE_TYPE_VALUES = ["Regular", "IBL", "ITH"] as const;
const MACHINE_FREQUENCY_VALUES = ["13.5 MHz", "27.12 MHz"] as const;

function pickEnum<T extends string>(
  raw: FormDataEntryValue | null,
  allowed: ReadonlyArray<T>,
): T | null {
  if (typeof raw !== "string" || raw === "") return null;
  return (allowed as ReadonlyArray<string>).includes(raw) ? (raw as T) : null;
}

function pickNumber(
  raw: FormDataEntryValue | null,
  opts: { integer?: boolean; min?: number; max?: number } = {},
): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = opts.integer ? parseInt(raw, 10) : Number(raw);
  if (!Number.isFinite(n)) return null;
  if (opts.min !== undefined && n < opts.min) return null;
  if (opts.max !== undefined && n > opts.max) return null;
  return n;
}

function diffValue(
  oldVal: unknown,
  newVal: unknown,
): { old: string | null; new: string | null } | null {
  const oldStr = oldVal == null ? null : String(oldVal);
  const newStr = newVal == null ? null : String(newVal);
  if (oldStr === newStr) return null;
  return { old: oldStr, new: newStr };
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

export async function updateSessionTreatmentParamsAction(
  formData: FormData,
): Promise<TreatmentParamsResult> {
  const sessionId = formData.get("session_id");
  const clientId = formData.get("client_id");
  if (typeof sessionId !== "string" || !sessionId) {
    return { ok: false, error: "Missing session id." };
  }
  if (typeof clientId !== "string" || !clientId) {
    return { ok: false, error: "Missing client id." };
  }

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit sessions." };
  }

  const electrolysisMode = pickEnum(
    formData.get("electrolysis_mode"),
    ELECTROLYSIS_MODE_VALUES,
  );
  const apilusModalityRaw = pickEnum(
    formData.get("apilus_modality"),
    APILUS_MODALITY_VALUES,
  );
  // Galvanic mode never carries an apilus modality or energy level.
  const apilusModality =
    electrolysisMode === "galv" ? null : apilusModalityRaw;
  const intensityPct = pickNumber(formData.get("intensity_pct"), {
    min: 0,
    max: 100,
  });
  const duration = pickNumber(formData.get("duration_seconds"), { min: 0 });
  const pulses = pickNumber(formData.get("pulses"), { integer: true, min: 0 });
  const minutesPerformed = pickNumber(formData.get("minutes_performed"), {
    integer: true,
    min: 0,
  });
  const energyLevelRaw = pickNumber(formData.get("energy_level"), {
    integer: true,
    min: 0,
  });
  const energyLevel = electrolysisMode === "galv" ? null : energyLevelRaw;
  const probeType = pickEnum(formData.get("probe_type"), PROBE_TYPE_VALUES);
  const machineFrequency = pickEnum(
    formData.get("machine_frequency"),
    MACHINE_FREQUENCY_VALUES,
  );

  const supabase = await createClient();

  const { data: existing, error: lookupErr } = await supabase
    .from("sessions")
    .select(
      "id, electrolysis_mode, apilus_modality, intensity_pct, duration_seconds, pulses, minutes_performed, energy_level, probe_type, machine_frequency",
    )
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

  const next = {
    electrolysis_mode: electrolysisMode,
    apilus_modality: apilusModality,
    intensity_pct: intensityPct,
    duration_seconds: duration,
    pulses,
    minutes_performed: minutesPerformed,
    energy_level: energyLevel,
    probe_type: probeType,
    machine_frequency: machineFrequency,
  } as const;

  const diffs: Array<{
    field: string;
    old_value: string | null;
    new_value: string | null;
  }> = [];
  for (const key of Object.keys(next) as Array<keyof typeof next>) {
    const change = diffValue(
      (existing as Record<string, unknown>)[key],
      next[key],
    );
    if (change) {
      diffs.push({ field: key, old_value: change.old, new_value: change.new });
    }
  }

  if (diffs.length === 0) {
    return { ok: true };
  }

  const { error: updateErr } = await supabase
    .from("sessions")
    .update(next)
    .eq("id", sessionId)
    .eq("studio_id", studio.id);
  if (updateErr) {
    return {
      ok: false,
      error: `Failed to update session: ${updateErr.message}`,
    };
  }

  const auditRows = diffs.map((d) => ({
    session_id: sessionId,
    edited_by_practitioner_id: practitioner.id,
    field: d.field,
    old_value: d.old_value,
    new_value: d.new_value,
  }));
  const { error: auditErr } = await supabase
    .from("session_audit")
    .insert(auditRows);
  if (auditErr) {
    console.error("Failed to write session_audit rows:", auditErr);
  }

  revalidatePath(`/clients/${clientId}/sessions/${sessionId}`);
  revalidatePath(`/clients/${clientId}`);
  revalidatePath("/dashboard");

  return { ok: true };
}
