"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type { TreatmentGoalStatus } from "@/lib/types/database";

const MAX_HOURS = 1000;

function trimmed(value: FormDataEntryValue | null): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullable(value: FormDataEntryValue | null): string | null {
  const t = trimmed(value);
  return t.length === 0 ? null : t;
}

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function upsertTreatmentGoalAction(
  formData: FormData,
): Promise<ActionResult> {
  const clientId = trimmed(formData.get("client_id"));
  const hoursRaw = trimmed(formData.get("estimated_hours"));
  const statusRaw = trimmed(formData.get("status"));

  if (!clientId) return { ok: false, error: "Missing client id." };
  const hours = Number(hoursRaw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_HOURS) {
    return {
      ok: false,
      error: `Estimated hours must be between 1 and ${MAX_HOURS}.`,
    };
  }
  const minutes = Math.round(hours * 60);
  const status: TreatmentGoalStatus =
    statusRaw === "reached" || statusRaw === "revised" || statusRaw === "archived"
      ? statusRaw
      : "active";

  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  const supabase = await createClient();

  // Verify client belongs to this studio (defense in depth above RLS).
  const { data: client, error: clientErr } = await supabase
    .from("clients")
    .select("id")
    .eq("id", clientId)
    .eq("studio_id", studio.id)
    .maybeSingle();
  if (clientErr) return { ok: false, error: clientErr.message };
  if (!client) return { ok: false, error: "Client not found." };

  // Upsert by client_id (unique constraint). On conflict, update in place
  // and stamp updated_at.
  const { error } = await supabase
    .from("treatment_goals")
    .upsert(
      {
        client_id: clientId,
        studio_id: studio.id,
        estimated_total_minutes: minutes,
        notes: nullable(formData.get("notes")),
        status,
        created_by: practitioner.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id" },
    );
  if (error) return { ok: false, error: `Failed to save goal: ${error.message}` };

  revalidatePath(`/clients/${clientId}`);
  return { ok: true };
}
