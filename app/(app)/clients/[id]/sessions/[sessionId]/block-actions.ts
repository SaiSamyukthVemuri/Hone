"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import type {
  ApilusModality,
  MachineFrequency,
  ProbeType,
  SessionBlock,
  SessionBlockSide,
  SessionMode,
} from "@/lib/types/database";

// Body Chart v1 Phase B caps + enum mirror the migration 0039 CHECKs.
// Defense in depth: RLS + DB CHECK already reject bad values; the action
// surfaces clean errors instead of opaque postgres messages.
const PRIMARY_AREA_MAX = 60;
const CUSTOM_AREA_DETAIL_MAX = 60;
const SIDE_VALUES: ReadonlyArray<SessionBlockSide> = [
  "center",
  "left",
  "right",
  "bilateral",
  "n/a",
];
function isSide(v: string): v is SessionBlockSide {
  return (SIDE_VALUES as ReadonlyArray<string>).includes(v);
}

type StructuredArea = {
  primary_area: string | null;
  side: SessionBlockSide | null;
  custom_area_detail: string | null;
};

// Validate + normalize structured-area input. Empty strings → null.
// Returns either a sanitized triple or a friendly error.
function normalizeStructuredArea(input: {
  primaryArea?: string | null;
  side?: string | null;
  customAreaDetail?: string | null;
}): { ok: true; value: StructuredArea } | { ok: false; error: string } {
  const rawArea = (input.primaryArea ?? "").trim();
  if (rawArea.length > PRIMARY_AREA_MAX) {
    return {
      ok: false,
      error: `Primary area must be ${PRIMARY_AREA_MAX} characters or fewer.`,
    };
  }
  const primary_area = rawArea.length === 0 ? null : rawArea;

  const rawSide = (input.side ?? "").trim();
  let side: SessionBlockSide | null = null;
  if (rawSide.length > 0) {
    if (!isSide(rawSide)) {
      return { ok: false, error: "Side must be center, left, right, bilateral, or n/a." };
    }
    side = rawSide;
  }

  const rawDetail = (input.customAreaDetail ?? "").trim();
  if (rawDetail.length > CUSTOM_AREA_DETAIL_MAX) {
    return {
      ok: false,
      error: `Specifics must be ${CUSTOM_AREA_DETAIL_MAX} characters or fewer.`,
    };
  }
  const custom_area_detail = rawDetail.length === 0 ? null : rawDetail;

  return { ok: true, value: { primary_area, side, custom_area_detail } };
}

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
  // Body Chart v1 Phase B — optional structured anatomical area.
  primaryArea?: string | null;
  side?: string | null;
  customAreaDetail?: string | null;
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

  // Validate the new structured-area fields up front so the caller gets a
  // clean message instead of an opaque CHECK violation. Existing block
  // fields (block_name etc.) are unchanged — never derive primary_area
  // from block_name or vice versa; they are intentionally independent.
  const areaCheck = normalizeStructuredArea({
    primaryArea: input.primaryArea ?? null,
    side: input.side ?? null,
    customAreaDetail: input.customAreaDetail ?? null,
  });
  if (!areaCheck.ok) return areaCheck;

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
      primary_area: areaCheck.value.primary_area,
      side: areaCheck.value.side,
      custom_area_detail: areaCheck.value.custom_area_detail,
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
      // Body Chart v1 Phase B — structured-area columns are patchable so
      // a follow-up inline editor can mutate them. block_name remains
      // independent; this action never derives one from the other.
      | "primary_area"
      | "side"
      | "custom_area_detail"
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

  // Validate any structured-area fields present in the patch. Each is
  // independent: callers can update just block_name without sending
  // area fields, or just primary_area without touching block_name.
  const patch = input.patch;
  const wantsArea =
    "primary_area" in patch ||
    "side" in patch ||
    "custom_area_detail" in patch;
  let normalizedPatch = patch;
  if (wantsArea) {
    const areaCheck = normalizeStructuredArea({
      primaryArea: patch.primary_area ?? null,
      side: patch.side ?? null,
      customAreaDetail: patch.custom_area_detail ?? null,
    });
    if (!areaCheck.ok) return areaCheck;
    normalizedPatch = {
      ...patch,
      ...("primary_area" in patch
        ? { primary_area: areaCheck.value.primary_area }
        : {}),
      ...("side" in patch ? { side: areaCheck.value.side } : {}),
      ...("custom_area_detail" in patch
        ? { custom_area_detail: areaCheck.value.custom_area_detail }
        : {}),
    };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("session_blocks")
    .update(normalizedPatch)
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
