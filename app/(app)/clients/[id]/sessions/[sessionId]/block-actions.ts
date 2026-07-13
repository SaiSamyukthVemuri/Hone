"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { assertSessionForClient } from "@/lib/sessions/session-lineage";
import { findProbeOptionByKey } from "@/lib/probes";
import { normalizeChips } from "@/lib/observation-chips";
import {
  validateTreatmentArea,
  isCanonicalTreatmentArea,
} from "@/lib/sessions/area-validation";
import {
  isLaterality,
  deriveLegacyProjection,
  type BlockArea,
  type Laterality,
} from "@/lib/sessions/block-areas";
import {
  isNumbingStatus,
  isReactionType,
  isToleranceRating,
  type NumbingStatus,
  type ReactionType,
} from "@/lib/sessions/clinical-response";
import {
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
  PULSE_DELAY_RANGE_ERROR,
} from "@/lib/constants";
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

// PR #190 (clinical memory, migration 0082). Structured client
// response per block. All optional; the DB CHECKs are the backstop,
// this validator surfaces clean errors. A caution note implies the
// caution flag so a practitioner who types a note but misses the
// checkbox still gets the flag on the next visit.
type ClinicalResponseInput = {
  toleranceRating?: number | null;
  reactionType?: string | null;
  reactionNotes?: string | null;
  cautionForNextSession?: boolean;
  cautionNote?: string | null;
  // PR #279: whether the client used numbing (factual record). "" / null /
  // undefined -> Not recorded (NULL).
  numbingStatus?: string | null;
};

type ClinicalResponseColumns = {
  tolerance_rating: number | null;
  reaction_type: ReactionType | null;
  reaction_notes: string | null;
  caution_for_next_session: boolean;
  caution_note: string | null;
  numbing_status: NumbingStatus | null;
};

function normalizeClinicalResponse(
  input: ClinicalResponseInput,
):
  | { ok: true; columns: ClinicalResponseColumns }
  | { ok: false; error: string } {
  const rating = input.toleranceRating ?? null;
  if (rating !== null && !isToleranceRating(rating)) {
    return {
      ok: false,
      error: "Tolerance rating must be a whole number from 1 to 5.",
    };
  }
  const reaction = input.reactionType || null;
  if (reaction !== null && !isReactionType(reaction)) {
    return { ok: false, error: "Pick a skin response from the list." };
  }
  const reactionNotes = input.reactionNotes?.trim() || null;
  const cautionNote = input.cautionNote?.trim() || null;
  const cautionFlag = Boolean(input.cautionForNextSession) || cautionNote !== null;
  const numbing = input.numbingStatus || null;
  if (numbing !== null && !isNumbingStatus(numbing)) {
    return { ok: false, error: "Pick a numbing option from the list." };
  }
  return {
    ok: true,
    columns: {
      tolerance_rating: rating,
      reaction_type: reaction,
      reaction_notes: reactionNotes,
      caution_for_next_session: cautionFlag,
      caution_note: cautionNote,
      numbing_status: numbing,
    },
  };
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
  // Explicit "I deliberately picked Other" signal from the client. Non-canonical
  // primary_area is accepted ONLY when this is true (see lib/sessions/area-validation).
  areaIsCustom?: boolean;
}): { ok: true; value: StructuredArea } | { ok: false; error: string } {
  // PR 2: canonical-or-explicit-custom validation against the flat AREAS list.
  const areaCheck = validateTreatmentArea(
    input.primaryArea,
    input.areaIsCustom ?? false,
    PRIMARY_AREA_MAX,
  );
  if (!areaCheck.ok) return { ok: false, error: areaCheck.error };
  const primary_area = areaCheck.value;

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

// ---------------------------------------------------------------------------
// Multi-area + per-area laterality (migration 0128, session_block_areas).
// ---------------------------------------------------------------------------
const AREA_MAX = 60;

export type AreaSetInput = ReadonlyArray<{ area?: string | null; laterality?: string | null }>;

// Validate + canonicalize the submitted area set: each area is 1..60 chars
// (canonical or a custom "Other" value, matching primary_area's flexibility);
// laterality is one of the approved values; duplicate (area, laterality) pairs
// are rejected (the DB unique enforces this too). Order is preserved.
function normalizeAreaSet(
  input: AreaSetInput,
): { ok: true; value: BlockArea[] } | { ok: false; error: string } {
  const out: BlockArea[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const area = (raw.area ?? "").trim();
    if (area.length === 0) continue; // blank rows are dropped, not an error
    if (area.length > AREA_MAX) {
      return { ok: false, error: `Treatment area must be ${AREA_MAX} characters or fewer.` };
    }
    const lat = raw.laterality ?? "";
    if (!isLaterality(lat)) {
      return { ok: false, error: "Choose a side for every selected area." };
    }
    const key = area.toLowerCase() + ":" + lat;
    if (seen.has(key)) {
      return { ok: false, error: `"${area}" is selected twice with the same side.` };
    }
    seen.add(key);
    out.push({ area, laterality: lat as Laterality });
  }
  return { ok: true, value: out };
}

// Session Logging Phase B: the eight structured probe columns
// (migration 0041) are always written as a set, derived server-side from
// a single catalog key. The lib/probes.ts catalog is the source of truth
// — the action never trusts decomposed fields from the client. An empty/
// null key clears the structured probe (all columns NULL). Legacy
// probe_type / probe_size are NOT touched here.
type ProbeColumns = {
  probe_key: string | null;
  probe_brand: string | null;
  probe_material: string | null;
  probe_piece_type: string | null;
  probe_shank: string | null;
  probe_size_value: string | null;
  probe_length: string | null;
  probe_label: string | null;
};

const EMPTY_PROBE_COLUMNS: ProbeColumns = {
  probe_key: null,
  probe_brand: null,
  probe_material: null,
  probe_piece_type: null,
  probe_shank: null,
  probe_size_value: null,
  probe_length: null,
  probe_label: null,
};

function resolveStructuredProbe(
  key: string | null | undefined,
): { ok: true; columns: ProbeColumns } | { ok: false; error: string } {
  const trimmed = (key ?? "").trim();
  if (trimmed.length === 0) {
    return { ok: true, columns: { ...EMPTY_PROBE_COLUMNS } };
  }
  const option = findProbeOptionByKey(trimmed);
  if (!option) {
    return {
      ok: false,
      error: "That probe is not a recognized option. Pick one from the list.",
    };
  }
  return {
    ok: true,
    columns: {
      probe_key: option.key,
      probe_brand: option.brand,
      probe_material: option.material,
      probe_piece_type: option.pieceType,
      probe_shank: option.shank,
      probe_size_value: option.size,
      probe_length: option.length,
      probe_label: option.displayLabel,
    },
  };
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
  // PR 2: explicit "Other" custom-area intent from the client.
  areaIsCustom?: boolean;
  // Session Logging Phase B — optional structured probe (catalog key).
  // Validated + decomposed server-side. Empty/absent → no structured probe.
  probeOptionKey?: string | null;
};

// PR #286: clinical lineage. Every charting write below validates the session
// belongs to BOTH the studio AND the route client (input.clientId) via the
// shared assertSessionForClient — not just the studio. This closes the
// same-studio wrong-client write that assertSessionInStudio (studio-only,
// removed) allowed. Block/entry writes remain scoped by the (now client-
// validated) session_id, and migration 0094 guarantees block ∈ session and
// entry ∈ block ∈ session, so the whole lineage chain is client-correct.


// PR #203 (migration 0084): sticky machine-frequency default.
// Chloe's machine frequency "pretty much always stays the same unless
// I change it", so the last value she saves on a treatment area
// becomes her default for NEW treatment-area drafts (cross-session,
// cross-device). Best-effort UI preference: it never blocks or fails
// the treatment-area save, validates against the same two allowed
// values as the schema CHECK, and writes only the authenticated
// practitioner's own row.
async function rememberMachineFrequencyDefault(
  practitionerId: string,
  frequency: MachineFrequency | null | undefined,
): Promise<void> {
  if (frequency !== "13.56 MHz" && frequency !== "27.12 MHz") return;
  try {
    const admin = createAdminClient();
    await admin
      .from("practitioners")
      .update({ default_machine_frequency: frequency })
      .eq("id", practitionerId);
  } catch {
    // UI default only; the block row already saved.
  }
}

export async function createSessionBlockAction(
  input: CreateBlockInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot create blocks." };
  }
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

  // Validate the new structured-area fields up front so the caller gets a
  // clean message instead of an opaque CHECK violation. Existing block
  // fields (block_name etc.) are unchanged — never derive primary_area
  // from block_name or vice versa; they are intentionally independent.
  const areaCheck = normalizeStructuredArea({
    primaryArea: input.primaryArea ?? null,
    side: input.side ?? null,
    customAreaDetail: input.customAreaDetail ?? null,
    areaIsCustom: input.areaIsCustom ?? false,
  });
  if (!areaCheck.ok) return areaCheck;

  // Structured probe is validated against the catalog server-side. Legacy
  // probe_type / probe_size below are written independently (and remain
  // null in the area-first flow, which no longer collects them).
  const probeCheck = resolveStructuredProbe(input.probeOptionKey);
  if (!probeCheck.ok) return probeCheck;

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
      ...probeCheck.columns,
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
  // Session Logging Phase B — structured probe. Separate from `patch`
  // because the eight columns are derived server-side from this single
  // catalog key (never trusted from the client). Semantics:
  //   - undefined  → leave the structured probe columns untouched
  //   - null / ""  → clear the structured probe (all columns NULL)
  //   - "<key>"    → validate against the catalog and set all columns
  // Legacy probe_type / probe_size remain patchable via `patch` above and
  // are never altered by this field.
  probeOptionKey?: string | null;
  // PR 2: explicit "Other" custom-area intent from the client.
  areaIsCustom?: boolean;
};

export async function updateSessionBlockAction(
  input: UpdateBlockInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit blocks." };
  }
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

  // Validate any structured-area fields present in the patch. Each is
  // independent: callers can update just block_name without sending
  // area fields, or just primary_area without touching block_name.
  const patch = input.patch;
  const wantsArea =
    "primary_area" in patch ||
    "side" in patch ||
    "custom_area_detail" in patch;
  let normalizedPatch: Partial<SessionBlock> = patch;
  if (wantsArea) {
    const areaCheck = normalizeStructuredArea({
      primaryArea: patch.primary_area ?? null,
      side: patch.side ?? null,
      customAreaDetail: patch.custom_area_detail ?? null,
      areaIsCustom: input.areaIsCustom ?? false,
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

  // Structured probe: only managed when probeOptionKey is explicitly
  // provided (string or null). undefined leaves the columns untouched.
  if (input.probeOptionKey !== undefined) {
    const probeCheck = resolveStructuredProbe(input.probeOptionKey);
    if (!probeCheck.ok) return probeCheck;
    normalizedPatch = { ...normalizedPatch, ...probeCheck.columns };
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

// ---------------------------------------------------------------------------
// PR #194 (Chloe retest): copy treatment areas + settings from the
// client's previous session into THIS session. Returning visits are
// usually similar; this seeds today's chart in one tap.
//
// What copies, per area: area identity (primary_area / side /
// custom detail / legacy block_name), machine settings (mode,
// modality, energy, minutes, frequency), and the structured probe.
// What NEVER copies: tolerance, reaction, reaction notes, caution
// flag/note (those describe the PREVIOUS visit; today's response is
// recorded fresh), per-pass entries/readings, and the next-session
// note. The copied areas are ordinary editable blocks.
//
// Duplication safety: refuses unless the current session has ZERO
// treatment areas, so the practitioner can never double-seed.
// ---------------------------------------------------------------------------
export type CopyPreviousAreasResult =
  | { ok: true; copiedCount: number }
  | { ok: false; error: string };

export async function copyPreviousSessionAreasAction(input: {
  clientId: string;
  sessionId: string;
  previousSessionId: string;
}): Promise<CopyPreviousAreasResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot log sessions." };
  }
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

  const supabase = await createClient();

  // The previous session must belong to the same studio AND client.
  const { data: prevSession, error: prevErr } = await supabase
    .from("sessions")
    .select("id, client_id")
    .eq("id", input.previousSessionId)
    .eq("studio_id", studio.id)
    .eq("client_id", input.clientId)
    .is("deleted_at", null)
    .maybeSingle();
  if (prevErr) return { ok: false, error: prevErr.message };
  if (!prevSession) {
    return { ok: false, error: "Previous session not found." };
  }

  // Refuse when today's session already has treatment areas.
  const { count: existingCount, error: countErr } = await supabase
    .from("session_blocks")
    .select("id", { count: "exact", head: true })
    .eq("session_id", input.sessionId)
    .is("deleted_at", null);
  if (countErr) return { ok: false, error: countErr.message };
  if ((existingCount ?? 0) > 0) {
    return {
      ok: false,
      error:
        "This session already has treatment areas. Copy is only available on an empty chart.",
    };
  }

  const { data: prevBlocks, error: blocksErr } = await supabase
    .from("session_blocks")
    .select(
      "sort_order, block_name, primary_area, side, custom_area_detail, mode, apilus_modality, energy_level, minutes_performed, machine_frequency, probe_key, probe_brand, probe_material, probe_piece_type, probe_shank, probe_size_value, probe_length, probe_label",
    )
    .eq("studio_id", studio.id)
    .eq("session_id", prevSession.id)
    .is("deleted_at", null)
    .order("sort_order", { ascending: true });
  if (blocksErr) return { ok: false, error: blocksErr.message };
  if (!prevBlocks || prevBlocks.length === 0) {
    return {
      ok: false,
      error: "The previous session has no treatment areas to copy.",
    };
  }

  const rows = prevBlocks.map((b, i) => {
    // PR 2: run each copied area through the same validator. A prior area that
    // is canonical is normalized to canonical casing; a legacy/custom area is
    // treated as explicit custom (areaIsCustom = it isn't canonical) so it is
    // PRESERVED verbatim, never dropped or rejected. Copies never regress data.
    const areaCheck = validateTreatmentArea(
      b.primary_area,
      !isCanonicalTreatmentArea(b.primary_area),
      PRIMARY_AREA_MAX,
    );
    const copiedPrimaryArea = areaCheck.ok ? areaCheck.value : b.primary_area;
    return {
      studio_id: studio.id,
      session_id: input.sessionId,
      sort_order: i + 1,
      block_name: b.block_name,
      primary_area: copiedPrimaryArea,
      side: b.side,
      custom_area_detail: b.custom_area_detail,
    mode: b.mode,
    apilus_modality: b.apilus_modality,
    energy_level: b.energy_level,
    minutes_performed: b.minutes_performed,
    machine_frequency: b.machine_frequency,
    probe_key: b.probe_key,
    probe_brand: b.probe_brand,
    probe_material: b.probe_material,
    probe_piece_type: b.probe_piece_type,
    probe_shank: b.probe_shank,
    probe_size_value: b.probe_size_value,
    probe_length: b.probe_length,
    probe_label: b.probe_label,
    // Response fields deliberately absent: tolerance_rating,
    // reaction_type, reaction_notes, caution_note default to null and
    // caution_for_next_session to false.
    };
  });

  const { error: insertErr } = await supabase
    .from("session_blocks")
    .insert(rows);
  if (insertErr) return { ok: false, error: insertErr.message };

  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return { ok: true, copiedCount: rows.length };
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
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

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

export type RemoveSessionAreaResult =
  | { ok: true; entriesRemoved: number; imagesRemoved: number }
  | { ok: false; error: string };

// Willow P1-B: remove a whole incorrectly-recorded treatment AREA from a DRAFT
// chart via the atomic aggregate soft-delete RPC (migration 0123). The block +
// its block-scoped electrolysis passes + its block-scoped images are voided in
// ONE trusted transaction with a mandatory reason and full actor/time
// attribution; finalized/void records are rejected by the RPC. Unlike the
// block-only softDeleteSessionBlockAction above, this does NOT orphan children.
export async function removeSessionAreaAction(
  input: SoftDeleteBlockInput,
): Promise<RemoveSessionAreaResult> {
  const reason = input.reason.trim();
  if (reason.length < 10) {
    return {
      ok: false,
      error: "Please give a reason for removing this area (at least 10 characters).",
    };
  }
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot remove areas." };
  }
  // Defense in depth: the RPC re-derives studio + actor from auth.uid(); this
  // early lineage check gives a clean error before the round-trip.
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("soft_delete_session_area", {
    p_session_id: input.sessionId,
    p_block_id: input.blockId,
    p_reason: reason,
  });
  if (error) {
    // A plpgsql check_violation (23514) carries a safe, human message.
    const business = error.code === "23514";
    return {
      ok: false,
      error: business ? error.message : "Couldn't remove the area right now. Please try again.",
    };
  }
  const row = Array.isArray(data) ? data[0] : data;
  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return {
    ok: true,
    entriesRemoved: Number(row?.entries_removed ?? 0),
    imagesRemoved: Number(row?.images_removed ?? 0),
  };
}

// =====================================================================
// One-page charting (Session Logging refactor).
//
// createTreatmentAreaWithEntryAction / updateTreatmentAreaWithEntryAction
// let the practitioner enter the treatment area, machine settings, probe,
// minutes AND the first set of readings on a single page and save once,
// instead of saving the area and then filling readings in a second form.
//
// They DO NOT replace createSessionBlockAction / updateSessionBlockAction
// or addElectrolysisEntryAction — those remain for the "add another pass"
// flow, the legacy entry form, and ensureBlockForSession. This is purely
// additive: same tables, same columns, no schema change.
//
// The first entry's `area`/`areas` is derived from the block's
// primary_area (electrolysis_entries.area is NOT NULL), so readings can't
// be saved without a treatment area. Machine settings are snapshotted onto
// the entry exactly like addElectrolysisEntryAction (galvanic carries no
// apilus_modality/energy_level). Legacy probe_type/probe_size are never
// written or cleared on entries here — the structured probe lives on the
// block, and the new flow leaves the entry's legacy probe columns null on
// create and untouched on update.
// =====================================================================

// Session Logging Phase 3: structured blend / galvanic readings. The legacy
// generic intensity / duration_seconds are no longer written by the one-page
// flow (they stay on old rows for display); thermolysis and galvanic readings
// now have their own fields. pulse_count and hairs_treated are unchanged.
export type EntryReadingsInput = {
  pulseCount?: number | null;
  // Seconds between high-frequency pulses; only meaningful when pulseCount > 1.
  pulseDelaySeconds?: number | null;
  hairsTreated?: number | null;
  comments?: string | null;
  // Migration 0108: structured observation chips (canonical labels). Chips are
  // now explicit state, not re-derived from `comments`, so none can silently
  // drop. Normalized on write via normalizedChips().
  observationChips?: string[] | null;
  galvanicMa?: number | null;
  galvanicDurationSeconds?: number | null;
  galvanicIntensityPercent?: number | null;
  thermolysisIntensityPercent?: number | null;
  thermolysisDurationSeconds?: number | null;
  unitsOfLye?: number | null;
};

function clampPulseCount(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(n)) return PULSE_COUNT_DEFAULT;
  return Math.min(PULSE_COUNT_MAX, Math.max(PULSE_COUNT_MIN, Math.trunc(n)));
}

// Pulse delay is stored ONLY when multiple pulses were done (pulse_count > 1);
// otherwise it is null (single-pulse entries carry no delay). Returns the
// rounded-to-2dp value when applicable, else null. Range validity is checked
// separately in validateReadings so an out-of-range value returns a clean
// error rather than being silently clamped.
function resolvePulseDelaySeconds(r: EntryReadingsInput): number | null {
  const count = clampPulseCount(r.pulseCount);
  if (count <= 1) return null;
  const v = r.pulseDelaySeconds;
  if (v == null || !Number.isFinite(v)) return null;
  return Math.round(v * 100) / 100;
}

// pulse_count defaults to 1, so it alone is NOT treated as "a reading was
// entered". Used to decide whether a treatment area is required and whether
// a first entry must be created for a previously empty block.
function readingsPresent(r: EntryReadingsInput): boolean {
  return (
    r.hairsTreated != null ||
    r.galvanicMa != null ||
    r.galvanicDurationSeconds != null ||
    r.galvanicIntensityPercent != null ||
    r.thermolysisIntensityPercent != null ||
    r.thermolysisDurationSeconds != null ||
    r.unitsOfLye != null ||
    (typeof r.comments === "string" && r.comments.trim().length > 0) ||
    (Array.isArray(r.observationChips) && r.observationChips.length > 0)
  );
}

function normalizedComments(r: EntryReadingsInput): string | null {
  return typeof r.comments === "string" && r.comments.trim().length > 0
    ? r.comments.trim()
    : null;
}

// Structured observation chips for the DB write: always a canonical, deduped
// array (never null — the column is jsonb NOT NULL default []). Unknown/garbage
// values collapse to [] rather than corrupting the clinical record.
function normalizedChips(r: EntryReadingsInput): string[] {
  return normalizeChips(r.observationChips);
}

// Server-side range validation mirroring the DB CHECK (migration 0042) so
// the practitioner gets a clean message instead of an opaque constraint
// violation. Empty/null values are always allowed.
function validateReadings(
  r: EntryReadingsInput,
): { ok: true } | { ok: false; error: string } {
  const nonNeg: ReadonlyArray<[number | null | undefined, string]> = [
    [r.galvanicMa, "Galvanic mA"],
    [r.galvanicDurationSeconds, "Galvanic duration"],
    [r.thermolysisDurationSeconds, "Thermolysis duration"],
    [r.unitsOfLye, "Units of lye"],
  ];
  for (const [v, label] of nonNeg) {
    if (v != null && (!Number.isFinite(v) || v < 0)) {
      return { ok: false, error: `${label} must be a non-negative number.` };
    }
  }
  const percent: ReadonlyArray<[number | null | undefined, string]> = [
    [r.galvanicIntensityPercent, "Galvanic intensity"],
    [r.thermolysisIntensityPercent, "Thermolysis intensity"],
  ];
  for (const [v, label] of percent) {
    if (v != null && (!Number.isFinite(v) || v < 0 || v > 100)) {
      return { ok: false, error: `${label} must be between 0 and 100.` };
    }
  }
  // Pulse delay: validated only when multiple pulses were done (pulse_count >
  // 1). A single-pulse entry carries no delay, so a stale draft value is
  // ignored rather than rejected. When applicable it must be in [0.03, 1.90].
  if (clampPulseCount(r.pulseCount) > 1 && r.pulseDelaySeconds != null) {
    const d = r.pulseDelaySeconds;
    if (!Number.isFinite(d) || d < PULSE_DELAY_MIN || d > PULSE_DELAY_MAX) {
      return { ok: false, error: PULSE_DELAY_RANGE_ERROR };
    }
  }
  return { ok: true };
}

// Mode-aware structured reading columns: galvanic fields apply to galvanic
// and blend; thermolysis fields apply to thermolysis and blend. Anything
// outside the mode is stored as null so a thermolysis entry never carries
// stray galvanic numbers (and vice versa), regardless of leftover draft
// state in the form.
function structuredReadingColumns(
  mode: SessionMode | null,
  r: EntryReadingsInput,
): {
  galvanic_ma: number | null;
  galvanic_duration_seconds: number | null;
  galvanic_intensity_percent: number | null;
  thermolysis_intensity_percent: number | null;
  thermolysis_duration_seconds: number | null;
  units_of_lye: number | null;
} {
  const wantGalv = mode === "galv" || mode === "blend";
  const wantThermo = mode === "thermo" || mode === "blend";
  return {
    galvanic_ma: wantGalv ? (r.galvanicMa ?? null) : null,
    galvanic_duration_seconds: wantGalv
      ? (r.galvanicDurationSeconds ?? null)
      : null,
    galvanic_intensity_percent: wantGalv
      ? (r.galvanicIntensityPercent ?? null)
      : null,
    thermolysis_intensity_percent: wantThermo
      ? (r.thermolysisIntensityPercent ?? null)
      : null,
    thermolysis_duration_seconds: wantThermo
      ? (r.thermolysisDurationSeconds ?? null)
      : null,
    units_of_lye: wantGalv ? (r.unitsOfLye ?? null) : null,
  };
}

// Entry-level machine snapshot, mirroring addElectrolysisEntryAction.
// Galvanic carries no apilus_modality or energy_level. probe_type/probe_size
// are intentionally excluded: on create they default to null, and on update
// we must not wipe any legacy probe data an existing entry may carry.
function entryMachineSnapshot(input: {
  mode: SessionMode | null;
  apilusModality: ApilusModality | null;
  energyLevel: number | null;
  minutesPerformed: number | null;
  machineFrequency: MachineFrequency | null;
}): {
  mode: SessionMode | null;
  apilus_modality: ApilusModality | null;
  energy_level: number | null;
  minutes_performed: number | null;
  machine_frequency: MachineFrequency | null;
} {
  const isGalv = input.mode === "galv";
  return {
    mode: input.mode,
    apilus_modality: isGalv ? null : input.apilusModality,
    energy_level: isGalv ? null : input.energyLevel,
    minutes_performed: input.minutesPerformed,
    machine_frequency: input.machineFrequency,
  };
}

export type CreateAreaWithEntryInput = {
  clientId: string;
  sessionId: string;
  mode?: SessionMode | null;
  apilusModality?: ApilusModality | null;
  energyLevel?: number | null;
  minutesPerformed?: number | null;
  probeOptionKey?: string | null;
  // PR #205 (migration 0085): probe lot/batch number for the
  // health-inspection client procedure record. Optional free text.
  probeLotNumber?: string | null;
  machineFrequency?: MachineFrequency | null;
  primaryArea?: string | null;
  side?: string | null;
  customAreaDetail?: string | null;
  areaIsCustom?: boolean;
  // Multi-area (0128): the full set of areas treated with these settings, each
  // with its own laterality. When present + non-empty it is authoritative over
  // the single primaryArea/side above (which become a legacy projection).
  areas?: AreaSetInput;
  readings?: EntryReadingsInput;
  // PR #190 (migration 0082): structured client response, all optional.
  toleranceRating?: number | null;
  reactionType?: string | null;
  reactionNotes?: string | null;
  cautionForNextSession?: boolean;
  cautionNote?: string | null;
  // PR #279 (migration 0095): numbing record + whether the probe lot was
  // confirmed for this treatment. Both optional; defaults are Not recorded /
  // not confirmed.
  numbingStatus?: string | null;
  probeLotConfirmed?: boolean;
};

export async function createTreatmentAreaWithEntryAction(
  input: CreateAreaWithEntryInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot log sessions." };
  }
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

  const areaCheck = normalizeStructuredArea({
    primaryArea: input.primaryArea ?? null,
    side: input.side ?? null,
    customAreaDetail: input.customAreaDetail ?? null,
    areaIsCustom: input.areaIsCustom ?? false,
  });
  if (!areaCheck.ok) return areaCheck;

  const probeCheck = resolveStructuredProbe(input.probeOptionKey);
  if (!probeCheck.ok) return probeCheck;

  const responseCheck = normalizeClinicalResponse(input);
  if (!responseCheck.ok) return responseCheck;

  // Migration 0128/0129: when `areas` is provided (the area-selection form path),
  // the structured set is CANONICAL for this block — for one area, many, OR zero
  // — and the whole save goes through the atomic RPC (which writes the block +
  // legacy projection + the COMPLETE area set in one transaction, replacing any
  // stale rows). `areaRows` may be [] (an intentionally area-less block: the RPC
  // atomically clears the child set). `areas` ABSENT → the legacy single-area
  // path (SimplifiedEntryForm + other callers) is unchanged.
  const areaSetCheck = input.areas !== undefined ? normalizeAreaSet(input.areas) : null;
  if (areaSetCheck && !areaSetCheck.ok) return areaSetCheck;
  const areaRows = areaSetCheck ? areaSetCheck.value : null;
  const useAreaRpc = areaRows !== null;
  const proj = areaRows && areaRows.length > 0 ? deriveLegacyProjection(areaRows) : null;
  const blockPrimaryArea = proj
    ? proj.primaryArea
    : areaRows
      ? null
      : areaCheck.value.primary_area;
  const blockSide = proj ? proj.side : areaRows ? null : areaCheck.value.side;
  const blockCustomDetail = areaRows ? null : areaCheck.value.custom_area_detail;

  const readings = input.readings ?? {};
  const area = blockPrimaryArea;

  const readingsCheck = validateReadings(readings);
  if (!readingsCheck.ok) return readingsCheck;

  // The first entry's area is the treatment area. An entry needs a (NOT
  // NULL) area, so readings can't be saved without one.
  if (!area && readingsPresent(readings)) {
    return {
      ok: false,
      error: "Choose a treatment area before saving treatment details.",
    };
  }

  const supabase = await createClient();

  // The settable block column bag, shared by both write paths.
  const blockFields = {
    block_name: null,
    mode: input.mode ?? null,
    apilus_modality: input.apilusModality ?? null,
    energy_level: input.energyLevel ?? null,
    minutes_performed: input.minutesPerformed ?? null,
    machine_frequency: input.machineFrequency ?? null,
    probe_lot_number: (input.probeLotNumber ?? "").trim().slice(0, 120) || null,
    // PR #279: confirmation only counts when a lot is actually present.
    probe_lot_confirmed:
      Boolean(input.probeLotConfirmed) && (input.probeLotNumber ?? "").trim() !== "",
    primary_area: blockPrimaryArea,
    side: blockSide,
    custom_area_detail: blockCustomDetail,
    ...probeCheck.columns,
    ...responseCheck.columns,
  };

  let block: SessionBlock;
  if (useAreaRpc) {
    // ATOMIC (migration 0129): the block + its legacy projection + the COMPLETE
    // structured area set are created together in one DB transaction — never a
    // block with a half-written area set, and no compensating soft-delete.
    const { data: newId, error: rpcErr } = await supabase.rpc(
      "create_session_block_with_areas",
      {
        p_studio_id: studio.id,
        p_session_id: input.sessionId,
        p_block: blockFields,
        p_areas: (areaRows ?? []).map((a, i) => ({
          area: a.area,
          laterality: a.laterality,
          display_order: i,
        })),
      },
    );
    if (rpcErr) return { ok: false, error: `Failed to save areas: ${rpcErr.message}` };
    const { data: row, error: rowErr } = await supabase
      .from("session_blocks")
      .select("*")
      .eq("id", newId as string)
      .single();
    if (rowErr || !row) {
      return { ok: false, error: rowErr?.message ?? "Saved block could not be loaded." };
    }
    block = row as SessionBlock;
  } else {
    // Area-less / legacy single-area path: a plain block insert (no area rows,
    // so no atomicity concern).
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
    const { data: row, error: blockErr } = await supabase
      .from("session_blocks")
      .insert({
        studio_id: studio.id,
        session_id: input.sessionId,
        sort_order: nextSort,
        ...blockFields,
      })
      .select("*")
      .single();
    if (blockErr || !row) {
      return { ok: false, error: blockErr?.message ?? "Failed to save the settings block." };
    }
    block = row as SessionBlock;
  }

  // Create the first entry only when a treatment area is present. An
  // area-less, readings-less save creates just the block (a valid "set the
  // area up later" state, same as the legacy block-only case).
  if (area) {
    const snap = entryMachineSnapshot({
      mode: (input.mode ?? null) as SessionMode | null,
      apilusModality: (input.apilusModality ?? null) as ApilusModality | null,
      energyLevel: input.energyLevel ?? null,
      minutesPerformed: input.minutesPerformed ?? null,
      machineFrequency: (input.machineFrequency ?? null) as
        | MachineFrequency
        | null,
    });
    const { error: entryErr } = await supabase
      .from("electrolysis_entries")
      .insert({
        session_id: input.sessionId,
        block_id: block.id,
        area,
        areas: areaRows && areaRows.length > 0 ? areaRows.map((sa) => sa.area) : [area],
        probe_lot_id: null,
        // Legacy generic intensity / duration_seconds are intentionally not
        // written; thermolysis / galvanic readings live in their own columns.
        pulse_count: clampPulseCount(readings.pulseCount),
        pulse_delay_seconds: resolvePulseDelaySeconds(readings),
        hairs_treated: readings.hairsTreated ?? null,
        comments: normalizedComments(readings),
        observation_chips: normalizedChips(readings),
        ...structuredReadingColumns((input.mode ?? null) as SessionMode | null, readings),
        ...snap,
      });
    if (entryErr) {
      // Cleanup: retire the just-created block so its minutes_performed
      // can't pollute TTT and no orphan treatment area is left behind.
      // PR #217: SOFT delete (deleted_at), matching the app's delete
      // posture everywhere else; the RLS hardening removed the
      // authenticated DELETE path on session_blocks, and every read
      // already filters deleted_at.
      await supabase
        .from("session_blocks")
        .update({ deleted_at: new Date().toISOString() })
        .eq("id", block.id)
        .eq("studio_id", studio.id);
      return {
        ok: false,
        error: `Failed to save treatment details: ${entryErr.message}`,
      };
    }
  }

  await rememberMachineFrequencyDefault(
    practitioner.id,
    (input.machineFrequency ?? null) as MachineFrequency | null,
  );
  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return { ok: true, block: block as SessionBlock };
}

export type UpdateAreaWithEntryInput = {
  clientId: string;
  sessionId: string;
  blockId: string;
  // The id of the block's first/primary entry, if one exists. When set, that
  // entry's readings are updated in place; entries 2..N are never touched.
  // When null/absent, the block had no entries and one is created if readings
  // and a treatment area are present.
  firstEntryId?: string | null;
  // Optimistic-concurrency token: the block.updated_at the form loaded. A stale
  // value (someone else edited the block since) makes the atomic update refuse
  // with a distinct conflict rather than silently overwriting.
  expectedUpdatedAt?: string | null;
  mode?: SessionMode | null;
  apilusModality?: ApilusModality | null;
  energyLevel?: number | null;
  minutesPerformed?: number | null;
  probeOptionKey?: string | null;
  // PR #205 (migration 0085): probe lot/batch number for the
  // health-inspection client procedure record. Optional free text.
  probeLotNumber?: string | null;
  machineFrequency?: MachineFrequency | null;
  primaryArea?: string | null;
  side?: string | null;
  customAreaDetail?: string | null;
  areaIsCustom?: boolean;
  // Multi-area (0128): the full set of areas treated with these settings, each
  // with its own laterality. When present + non-empty it is authoritative over
  // the single primaryArea/side above (which become a legacy projection).
  areas?: AreaSetInput;
  readings?: EntryReadingsInput;
  // PR #190 (migration 0082): structured client response. The edit
  // form initializes its draft from the block row and always sends
  // these back, so a save without touching the section round-trips
  // the stored values unchanged.
  toleranceRating?: number | null;
  reactionType?: string | null;
  reactionNotes?: string | null;
  cautionForNextSession?: boolean;
  cautionNote?: string | null;
  // PR #279 (migration 0095): numbing record + probe-lot confirmation. The edit
  // form seeds these from the block row and always sends them back.
  numbingStatus?: string | null;
  probeLotConfirmed?: boolean;
};

export async function updateTreatmentAreaWithEntryAction(
  input: UpdateAreaWithEntryInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit sessions." };
  }
  await assertSessionForClient(studio.id, input.clientId, input.sessionId);

  const areaCheck = normalizeStructuredArea({
    primaryArea: input.primaryArea ?? null,
    side: input.side ?? null,
    customAreaDetail: input.customAreaDetail ?? null,
    areaIsCustom: input.areaIsCustom ?? false,
  });
  if (!areaCheck.ok) return areaCheck;

  const probeCheck = resolveStructuredProbe(input.probeOptionKey);
  if (!probeCheck.ok) return probeCheck;

  const responseCheck = normalizeClinicalResponse(input);
  if (!responseCheck.ok) return responseCheck;

  // Migration 0128/0129: when `areas` is provided (the area-selection form path),
  // the structured set is CANONICAL for this block — for one area, many, OR zero
  // — and the whole save goes through the atomic RPC (which writes the block +
  // legacy projection + the COMPLETE area set in one transaction, replacing any
  // stale rows). `areaRows` may be [] (an intentionally area-less block: the RPC
  // atomically clears the child set). `areas` ABSENT → the legacy single-area
  // path (SimplifiedEntryForm + other callers) is unchanged.
  const areaSetCheck = input.areas !== undefined ? normalizeAreaSet(input.areas) : null;
  if (areaSetCheck && !areaSetCheck.ok) return areaSetCheck;
  const areaRows = areaSetCheck ? areaSetCheck.value : null;
  const useAreaRpc = areaRows !== null;
  const proj = areaRows && areaRows.length > 0 ? deriveLegacyProjection(areaRows) : null;
  const blockPrimaryArea = proj
    ? proj.primaryArea
    : areaRows
      ? null
      : areaCheck.value.primary_area;
  const blockSide = proj ? proj.side : areaRows ? null : areaCheck.value.side;
  const blockCustomDetail = areaRows ? null : areaCheck.value.custom_area_detail;

  const readings = input.readings ?? {};
  const area = blockPrimaryArea;

  const readingsCheck = validateReadings(readings);
  if (!readingsCheck.ok) return readingsCheck;

  // Creating a new first entry (block had none) needs an area, same NOT NULL
  // reason as create. Updating an existing entry keeps its current area when
  // the treatment area is cleared — we never null an existing entry's area.
  if (!input.firstEntryId && !area && readingsPresent(readings)) {
    return {
      ok: false,
      error: "Choose a treatment area before saving treatment details.",
    };
  }

  const supabase = await createClient();

  // block_name / block_notes are intentionally omitted so any legacy value
  // is preserved. Machine settings + structured area + structured probe are
  // fully overwritten from the form (which holds all of them).
  const blockFields = {
    mode: input.mode ?? null,
    apilus_modality: input.apilusModality ?? null,
    energy_level: input.energyLevel ?? null,
    minutes_performed: input.minutesPerformed ?? null,
    machine_frequency: input.machineFrequency ?? null,
    probe_lot_number: (input.probeLotNumber ?? "").trim().slice(0, 120) || null,
    // PR #279: confirmation only counts when a lot is actually present.
    probe_lot_confirmed:
      Boolean(input.probeLotConfirmed) && (input.probeLotNumber ?? "").trim() !== "",
    primary_area: blockPrimaryArea,
    side: blockSide,
    custom_area_detail: blockCustomDetail,
    ...probeCheck.columns,
    ...responseCheck.columns,
  };

  let block: SessionBlock;
  if (useAreaRpc) {
    // ATOMIC (migration 0129): the block update + legacy projection + the
    // COMPLETE replacement area set commit together in ONE transaction. There is
    // no window where the old area rows are deleted but the new set failed
    // (which would previously have left only the first legacy-projected area).
    const { error: rpcErr } = await supabase.rpc("update_session_block_with_areas", {
      p_studio_id: studio.id,
      p_session_id: input.sessionId,
      p_block_id: input.blockId,
      p_block: blockFields,
      p_areas: (areaRows ?? []).map((a, i) => ({
        area: a.area,
        laterality: a.laterality,
        display_order: i,
      })),
      p_expected_updated_at: input.expectedUpdatedAt ?? null,
    });
    if (rpcErr) {
      // Distinct stale-edit conflict (someone changed the block since it loaded).
      if (rpcErr.message?.includes("stale_block_version")) {
        return {
          ok: false,
          error:
            "This settings block was changed elsewhere. Reload the session and re-apply your edit.",
        };
      }
      return { ok: false, error: `Failed to save areas: ${rpcErr.message}` };
    }
    const { data: row, error: rowErr } = await supabase
      .from("session_blocks")
      .select("*")
      .eq("id", input.blockId)
      .single();
    if (rowErr || !row) {
      return { ok: false, error: rowErr?.message ?? "Saved block could not be loaded." };
    }
    block = row as SessionBlock;
  } else {
    // No `areas` submitted → plain block update; any prior child rows are left
    // untouched (backward-compatible single-area edit path).
    const { data: row, error: blockErr } = await supabase
      .from("session_blocks")
      .update(blockFields)
      .eq("id", input.blockId)
      .eq("studio_id", studio.id)
      .eq("session_id", input.sessionId)
      .is("deleted_at", null)
      .select("*")
      .single();
    if (blockErr || !row) {
      return { ok: false, error: blockErr?.message ?? "Failed to save the settings block." };
    }
    block = row as SessionBlock;
  }

  const snap = entryMachineSnapshot({
    mode: (input.mode ?? null) as SessionMode | null,
    apilusModality: (input.apilusModality ?? null) as ApilusModality | null,
    energyLevel: input.energyLevel ?? null,
    minutesPerformed: input.minutesPerformed ?? null,
    machineFrequency: (input.machineFrequency ?? null) as
      | MachineFrequency
      | null,
  });

  if (input.firstEntryId) {
    // Update the first/primary entry only — entries 2..N stay exactly as-is.
    // The entry's area is re-keyed only when a treatment area is set; it is
    // never nulled (preserves a NOT NULL area if the block area was cleared).
    // Legacy intensity / duration_seconds are intentionally NOT in this
    // patch, so any value an old entry carries is preserved. Thermolysis /
    // galvanic readings are written to their own columns.
    const entryUpdate: Record<string, unknown> = {
      pulse_count: clampPulseCount(readings.pulseCount),
      pulse_delay_seconds: resolvePulseDelaySeconds(readings),
      hairs_treated: readings.hairsTreated ?? null,
      comments: normalizedComments(readings),
      observation_chips: normalizedChips(readings),
      ...structuredReadingColumns(
        (input.mode ?? null) as SessionMode | null,
        readings,
      ),
      ...snap,
    };
    if (area) {
      entryUpdate.area = area;
      entryUpdate.areas = [area];
    }
    const { error: entryErr } = await supabase
      .from("electrolysis_entries")
      .update(entryUpdate)
      .eq("id", input.firstEntryId)
      .eq("block_id", input.blockId)
      .eq("session_id", input.sessionId);
    if (entryErr) {
      return {
        ok: false,
        error: `Failed to save treatment details: ${entryErr.message}`,
      };
    }
  } else if (area && readingsPresent(readings)) {
    // Block had no entries: create the first one now.
    const { error: entryErr } = await supabase
      .from("electrolysis_entries")
      .insert({
        session_id: input.sessionId,
        block_id: input.blockId,
        area,
        areas: areaRows && areaRows.length > 0 ? areaRows.map((sa) => sa.area) : [area],
        probe_lot_id: null,
        pulse_count: clampPulseCount(readings.pulseCount),
        pulse_delay_seconds: resolvePulseDelaySeconds(readings),
        hairs_treated: readings.hairsTreated ?? null,
        comments: normalizedComments(readings),
        observation_chips: normalizedChips(readings),
        ...structuredReadingColumns(
          (input.mode ?? null) as SessionMode | null,
          readings,
        ),
        ...snap,
      });
    if (entryErr) {
      return {
        ok: false,
        error: `Failed to save treatment details: ${entryErr.message}`,
      };
    }
  }

  await rememberMachineFrequencyDefault(
    practitioner.id,
    (input.machineFrequency ?? null) as MachineFrequency | null,
  );
  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return { ok: true, block: block as SessionBlock };
}
