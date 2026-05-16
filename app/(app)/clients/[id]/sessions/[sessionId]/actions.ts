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
