"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type {
  ApilusModality,
  MachineFrequency,
  ProbeType,
  SessionBlock,
  SessionMode,
} from "@/lib/types/database";

// Server actions for session blocks. Defined now so 17.5b.2 can wire them
// directly to UI without re-architecting. They are NOT called from any UI
// in 17.5b.1; entry creation still flows through addElectrolysisEntryAction,
// which calls ensureEntryHasBlock under the hood.

export type BlockResult =
  | { ok: true; block: SessionBlock }
  | { ok: false; error: string };

export type CreateBlockInput = {
  clientId: string;
  sessionId: string;
  blockName?: string | null;
  blockNotes?: string | null;
  mode?: SessionMode | null;
  apilusModality?: ApilusModality | null;
  energyLevel?: number | null;
  minutesPerformed?: number | null;
  probeType?: ProbeType | null;
  probeSize?: string | null;
  machineFrequency?: MachineFrequency | null;
};

async function assertSessionInStudio(
  studioId: string,
  sessionId: string,
): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("studio_id", studioId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(`Failed to load session: ${error.message}`);
  if (!data) throw new Error("Session not found.");
}

export async function createSessionBlockAction(
  input: CreateBlockInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot create blocks." };
  }
  await assertSessionInStudio(studio.id, input.sessionId);

  const supabase = await createClient();

  // Compute next sort_order in the session.
  const { data: existing, error: countErr } = await supabase
    .from("session_blocks")
    .select("sort_order")
    .eq("session_id", input.sessionId)
    .is("deleted_at", null)
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (countErr) return { ok: false, error: countErr.message };
  const nextSort = (existing?.sort_order ?? 0) + 1;

  const { data, error } = await supabase
    .from("session_blocks")
    .insert({
      studio_id: studio.id,
      session_id: input.sessionId,
      sort_order: nextSort,
      block_name: input.blockName ?? null,
      block_notes: input.blockNotes ?? null,
      mode: input.mode ?? null,
      apilus_modality: input.apilusModality ?? null,
      energy_level: input.energyLevel ?? null,
      minutes_performed: input.minutesPerformed ?? null,
      probe_type: input.probeType ?? null,
      probe_size: input.probeSize ?? null,
      machine_frequency: input.machineFrequency ?? null,
    })
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  return { ok: true, block: data as SessionBlock };
}

export type UpdateBlockInput = {
  clientId: string;
  sessionId: string;
  blockId: string;
  patch: Partial<
    Pick<
      SessionBlock,
      | "block_name"
      | "block_notes"
      | "mode"
      | "apilus_modality"
      | "energy_level"
      | "minutes_performed"
      | "probe_type"
      | "probe_size"
      | "machine_frequency"
      | "started_at"
      | "ended_at"
    >
  >;
};

export async function updateSessionBlockAction(
  input: UpdateBlockInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit blocks." };
  }
  await assertSessionInStudio(studio.id, input.sessionId);

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .update(input.patch)
    .eq("id", input.blockId)
    .eq("studio_id", studio.id)
    .eq("session_id", input.sessionId)
    .is("deleted_at", null)
    .select("*")
    .single();
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  return { ok: true, block: data as SessionBlock };
}

export type SoftDeleteBlockInput = {
  clientId: string;
  sessionId: string;
  blockId: string;
  reason: string;
};

export type SoftDeleteResult = { ok: true } | { ok: false; error: string };

export async function softDeleteSessionBlockAction(
  input: SoftDeleteBlockInput,
): Promise<SoftDeleteResult> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return { ok: false, error: "Reason must be at least 10 characters." };
  }
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot delete blocks." };
  }
  await assertSessionInStudio(studio.id, input.sessionId);

  const supabase = await createClient();
  const { error } = await supabase
    .from("session_blocks")
    .update({
      deleted_at: new Date().toISOString(),
      deleted_by: practitioner.id,
      delete_reason: reason,
    })
    .eq("id", input.blockId)
    .eq("studio_id", studio.id)
    .eq("session_id", input.sessionId)
    .is("deleted_at", null);
  if (error) return { ok: false, error: error.message };

  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  return { ok: true };
}
