"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { assertSessionForClient } from "@/lib/sessions/session-lineage";
import { findProbeOptionByKey } from "@/lib/probes";
import { normalizeChips } from "@/lib/observation-chips";
import { resolveProbeInventorySelection } from "@/lib/record-keeping/probe-inventory-validation";
import { validateTreatmentArea } from "@/lib/sessions/area-validation";
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
  normalizeNumbingNotes,
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
import {
  mapBlockCommandError,
  isStaleBlockVersion,
  GENERIC_BLOCK_COMMAND_ERROR,
} from "@/lib/sessions/block-command-errors";
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
  // 0156: optional free-text numbing note. Kept ONLY when numbingStatus ===
  // 'used'; trimmed; blank -> NULL. Never used to infer the status.
  numbingNotes?: string | null;
};

type ClinicalResponseColumns = {
  tolerance_rating: number | null;
  reaction_type: ReactionType | null;
  reaction_notes: string | null;
  caution_for_next_session: boolean;
  caution_note: string | null;
  numbing_status: NumbingStatus | null;
  numbing_notes: string | null;
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
  // 0156: the optional numbing note is preserved ONLY when numbing was actually
  // used; trimmed, blank/whitespace -> NULL (shared pure helper). Status 'none'
  // or NULL/not-recorded stores NULL — a note without "used" is discarded, never
  // used to infer that numbing was used, and no placeholder is ever fabricated.
  const numbingNotes = normalizeNumbingNotes(numbing, input.numbingNotes);
  return {
    ok: true,
    columns: {
      tolerance_rating: rating,
      reaction_type: reaction,
      reaction_notes: reactionNotes,
      caution_for_next_session: cautionFlag,
      caution_note: cautionNote,
      numbing_status: numbing,
      numbing_notes: numbingNotes,
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

  // L18 Phase 2: created through create_block_with_entry (migration 0166) with
  // p_with_entry FALSE — a block-only create must not fabricate an
  // electrolysis entry. sort_order is no longer computed here: the 0129
  // boundary the command delegates to derives it as max(sort_order)+1 inside
  // the same transaction, which also removes the read-then-insert race the
  // application-side calculation had.
  const { data: created, error } = await supabase.rpc("create_block_with_entry", {
    p_session_id: input.sessionId,
    p_client_id: input.clientId,
    p_block: {
      block_name: input.blockName ?? null,
      mode: input.mode ?? null,
      apilus_modality: input.apilusModality ?? null,
      energy_level: input.energyLevel ?? null,
      minutes_performed: input.minutesPerformed ?? null,
      machine_frequency: input.machineFrequency ?? null,
      primary_area: areaCheck.value.primary_area,
      side: areaCheck.value.side,
      custom_area_detail: areaCheck.value.custom_area_detail,
      ...probeCheck.columns,
    },
    // Columns the 0129 boundary does not own. Only sent when the caller
    // actually supplied them, so an omitted field stays unchanged.
    p_block_extra: {
      ...(input.blockNotes !== undefined ? { block_notes: input.blockNotes ?? null } : {}),
      ...(input.probeType !== undefined ? { probe_type: input.probeType ?? null } : {}),
      ...(input.probeSize !== undefined ? { probe_size: input.probeSize ?? null } : {}),
    },
    p_areas: [],
    p_with_entry: false,
    p_area: null,
    p_areas_list: null,
    p_probe_size: null,
    p_probe_lot_id: null,
    p_mode: null,
    p_pulse_count: null,
    p_pulse_delay_seconds: null,
    p_comments: null,
    p_observation_chips: null,
    p_apilus_modality: null,
    p_energy_level: null,
    p_minutes_performed: null,
    p_probe_type: null,
    p_machine_frequency: null,
    p_hairs_treated: null,
    p_galvanic_ma: null,
    p_galvanic_duration_seconds: null,
    p_thermolysis_intensity_percent: null,
    p_thermolysis_duration_seconds: null,
    p_units_of_lye: null,
  });
  if (error) return { ok: false, error: mapBlockCommandError(error) };

  const newBlockId = Array.isArray(created)
    ? (created[0] as { block_id?: string } | undefined)?.block_id
    : (created as { block_id?: string } | null)?.block_id;
  if (!newBlockId) return { ok: false, error: GENERIC_BLOCK_COMMAND_ERROR };

  // Callers expect the saved row.
  const { data, error: readErr } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("id", newBlockId)
    .single();
  if (readErr || !data) return { ok: false, error: GENERIC_BLOCK_COMMAND_ERROR };

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
  //
  // Allowlist the caller-suppliable columns BEFORE they reach .update(): the
  // patch type is erased at runtime, so a crafted request could otherwise
  // mass-assign server-managed columns. In particular the 0155 inventory link
  // (probe_inventory_item_id), the lot-number snapshot (probe_lot_number) and
  // the confirmation (probe_lot_confirmed) are ONLY ever written through the
  // validated resolver in the charting entry actions — never here.
  const PATCHABLE_BLOCK_COLUMNS = new Set<string>([
    "block_name",
    "block_notes",
    "mode",
    "apilus_modality",
    "energy_level",
    "minutes_performed",
    "probe_type",
    "probe_size",
    "machine_frequency",
    "started_at",
    "ended_at",
    "primary_area",
    "side",
    "custom_area_detail",
  ]);
  const patch: Partial<SessionBlock> = {};
  for (const [k, v] of Object.entries(input.patch)) {
    if (PATCHABLE_BLOCK_COLUMNS.has(k)) {
      (patch as Record<string, unknown>)[k] = v;
    }
  }
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

  // L18 Phase 2: written through update_block_with_entry (migration 0166) in
  // BLOCK-ONLY mode — p_with_entry false, so no unrelated entry is touched.
  //
  // The command delegates the shared block columns to 0129's
  // update_session_block_with_areas, which writes its WHOLE allow-list from
  // jsonb_populate_record. Sending this action's PARTIAL patch straight through
  // would therefore NULL every allow-listed column the patch omits. So the
  // current row is read and the patch overlaid on top, and the row's own
  // updated_at is passed as the optimistic-concurrency value — which closes the
  // read-modify-write window that merge would otherwise open, and reuses the
  // stale-edit message this file already shows elsewhere.
  const { data: current, error: readErr } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("id", input.blockId)
    .eq("studio_id", studio.id)
    .eq("session_id", input.sessionId)
    .is("deleted_at", null)
    .maybeSingle();
  if (readErr || !current) {
    return { ok: false, error: "That settings block could not be found in this session." };
  }
  const before = current as SessionBlock;

  // Columns 0129's update owns: send current values with the patch overlaid.
  const shared: Record<string, unknown> = {
    mode: before.mode,
    apilus_modality: before.apilus_modality,
    energy_level: before.energy_level,
    minutes_performed: before.minutes_performed,
    machine_frequency: before.machine_frequency,
    probe_lot_number: before.probe_lot_number,
    probe_lot_confirmed: before.probe_lot_confirmed,
    probe_inventory_item_id: before.probe_inventory_item_id,
    primary_area: before.primary_area,
    side: before.side,
    custom_area_detail: before.custom_area_detail,
    probe_key: before.probe_key,
    probe_brand: before.probe_brand,
    probe_material: before.probe_material,
    probe_piece_type: before.probe_piece_type,
    probe_shank: before.probe_shank,
    probe_size_value: before.probe_size_value,
    probe_length: before.probe_length,
    probe_label: before.probe_label,
    tolerance_rating: before.tolerance_rating,
    reaction_type: before.reaction_type,
    reaction_notes: before.reaction_notes,
    caution_for_next_session: before.caution_for_next_session,
    caution_note: before.caution_note,
    numbing_status: before.numbing_status,
    numbing_notes: before.numbing_notes,
  };
  // Columns 0129 does NOT own — sent as the strict p_block_extra allow-list.
  // Only keys actually PRESENT in the patch are sent, so an omitted field is
  // left unchanged and an explicit null clears it.
  const EXTRA_KEYS = [
    "block_name",
    "block_notes",
    "probe_type",
    "probe_size",
    "started_at",
    "ended_at",
  ] as const;
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(normalizedPatch)) {
    if ((EXTRA_KEYS as readonly string[]).includes(k)) extra[k] = v;
    else if (k in shared) shared[k] = v;
  }

  const { error } = await supabase.rpc("update_block_with_entry", {
    p_session_id: input.sessionId,
    p_client_id: input.clientId,
    p_block_id: input.blockId,
    p_block: shared,
    p_block_extra: extra,
    p_areas: [],
    p_expected_updated_at: before.updated_at,
    p_with_entry: false,
    p_entry_id: null,
    p_area: null,
    p_areas_list: null,
    p_probe_size: null,
    p_probe_lot_id: null,
    p_mode: null,
    p_pulse_count: null,
    p_pulse_delay_seconds: null,
    p_comments: null,
    p_observation_chips: null,
    p_apilus_modality: null,
    p_energy_level: null,
    p_minutes_performed: null,
    p_probe_type: null,
    p_machine_frequency: null,
    p_hairs_treated: null,
    p_galvanic_ma: null,
    p_galvanic_duration_seconds: null,
    p_thermolysis_intensity_percent: null,
    p_thermolysis_duration_seconds: null,
    p_units_of_lye: null,
  });
  if (error) return { ok: false, error: mapBlockCommandError(error) };

  // The command returns ids only; callers expect the saved row, so re-read it.
  const { data: saved, error: savedErr } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("id", input.blockId)
    .single();
  if (savedErr || !saved) {
    return { ok: false, error: GENERIC_BLOCK_COMMAND_ERROR };
  }

  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  return { ok: true, block: saved as SessionBlock };
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

  // TEMPORARY CONTAINMENT — the whole-session copy is paused (zero writes).
  //
  // The audit established that this action previously persisted real
  // session_blocks (including minutes + machine settings) into today's chart
  // BEFORE the practitioner explicitly saved today's treatment. Because the
  // "charted / performed / treatment-time / procedure-record" surfaces are
  // gated on mere row existence (there is no per-block draft flag), those
  // copied rows read as performed treatment prematurely. Until the separately
  // reviewed migration-first whole-session DRAFT representation exists, this
  // path must not run.
  //
  // The authenticated + current-session lineage checks above are preserved;
  // this then returns a fixed safe "unavailable" result BEFORE any
  // source-session lookup or any session_blocks read/insert. It performs ZERO
  // writes — no blocks, entries, areas, drafts, metrics, or audit records — and
  // cannot be bypassed by calling the action directly. The in-form "Copy
  // settings" control (a client-side prefill) is unaffected.
  return {
    ok: false,
    error:
      "Copy all areas from last session is temporarily unavailable while we upgrade it to preserve complete settings safely. You can still use Copy settings inside an individual treatment area.",
  };
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
  // L18 Phase 2: soft retirement through soft_delete_session_block (0166).
  // deleted_at and delete_reason are written by the command; deleted_by is
  // DERIVED there from auth.uid(), so removal attribution can no longer be
  // supplied by the caller. Still a soft delete — never a hard delete.
  const { error } = await supabase.rpc("soft_delete_session_block", {
    p_session_id: input.sessionId,
    p_client_id: input.clientId,
    p_block_id: input.blockId,
    p_reason: reason,
  });
  if (error) return { ok: false, error: mapBlockCommandError(error) };

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
  // galvanic_intensity_percent is a RETIRED reading: no current form supplies it,
  // it is deliberately NOT an input here, and any forged value is ignored. New
  // rows always store NULL; historical rows are preserved by omitting the column
  // from updates (see structuredReadingColumns + the create/update write paths).
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
// NOTE: galvanic_intensity_percent is intentionally NOT emitted here. It is a
// retired reading. Omitting it from this column set means:
//   - on an UPDATE of an existing entry, the column is left out of the patch, so
//     a historical stored value is preserved untouched (never wiped, never
//     round-tripped through a browser-controlled field);
//   - on an INSERT of a NEW entry, the create paths set it explicitly to NULL
//     (server-authoritative), so no forged value can land.
function structuredReadingColumns(
  mode: SessionMode | null,
  r: EntryReadingsInput,
): {
  galvanic_ma: number | null;
  galvanic_duration_seconds: number | null;
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
  // health-inspection client procedure record. Optional free text (the manual
  // path); DERIVED from the inventory row on the linked path.
  probeLotNumber?: string | null;
  // Migration 0155: the chosen sterile-inventory item id (durable link), or null
  // for a manual lot. Validated + snapshot-derived server-side.
  probeInventoryItemId?: string | null;
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
  // 0156: optional free-text numbing note (kept only when status is 'used').
  numbingNotes?: string | null;
  probeLotConfirmed?: boolean;
};

// L18 Phase 2: the block/entry atomicity exception that used to sit here is
// RETIRED.
// `create_block_with_entry` (migration 0166) now owns the block, its area rows
// and the first entry in ONE transaction, so the application-side compensating
// soft delete that used to follow a failed entry write is gone with it.
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

  // Migration 0155: resolve the probe-lot selection into a durable inventory
  // link + a lot-number SNAPSHOT. The inventory-linked path validates the id
  // server-side (UUID + same studio + nonblank lot + matching probe_key +
  // expired-policy) and derives the snapshot FROM THE DB ROW; the manual path
  // keeps the trimmed free-text. A forged / cross-studio / wrong-probe / stale /
  // expired-unconfirmed id is rejected — never falling back to client text.
  const inv = await resolveProbeInventorySelection(supabase, studio.id, {
    probeInventoryItemId: input.probeInventoryItemId ?? null,
    probeKey: probeCheck.columns.probe_key,
    manualLotNumber: input.probeLotNumber ?? null,
    probeLotConfirmed: Boolean(input.probeLotConfirmed),
  });
  if (!inv.ok) return inv;

  // The settable block column bag, shared by both write paths.
  const blockFields = {
    block_name: null,
    mode: input.mode ?? null,
    apilus_modality: input.apilusModality ?? null,
    energy_level: input.energyLevel ?? null,
    minutes_performed: input.minutesPerformed ?? null,
    machine_frequency: input.machineFrequency ?? null,
    probe_lot_number: inv.probeLotNumber,
    probe_inventory_item_id: inv.probeInventoryItemId,
    // Confirmation only counts when a lot is actually present.
    probe_lot_confirmed:
      Boolean(input.probeLotConfirmed) && (inv.probeLotNumber ?? "").trim() !== "",
    primary_area: blockPrimaryArea,
    side: blockSide,
    custom_area_detail: blockCustomDetail,
    ...probeCheck.columns,
    ...responseCheck.columns,
  };

  // L18 Phase 2: block + areas + first entry are now ONE transaction via
  // create_block_with_entry (migration 0166). Previously the block was created
  // first and the entry second, with a COMPENSATING soft-delete of the block if
  // the entry write failed — that compensation is gone because a failure now
  // rolls the block, its area rows and the entry back together.
  //
  // The entry payload is built from the SAME helpers the direct insert used, so
  // its shaping is unchanged: `entryMachineSnapshot` still nulls apilus_modality
  // and energy_level for a galvanic entry, and `structuredReadingColumns` still
  // mode-gates the galvanic/thermolysis readings. The legacy generic
  // `intensity`/`duration_seconds` remain unwritten — the command has no
  // parameter for them.
  const snap = entryMachineSnapshot({
    mode: (input.mode ?? null) as SessionMode | null,
    apilusModality: (input.apilusModality ?? null) as ApilusModality | null,
    energyLevel: input.energyLevel ?? null,
    minutesPerformed: input.minutesPerformed ?? null,
    machineFrequency: (input.machineFrequency ?? null) as MachineFrequency | null,
  });
  const readingCols = structuredReadingColumns(
    (input.mode ?? null) as SessionMode | null,
    readings,
  );
  const { data: createdRows, error: cmdErr } = await supabase.rpc(
    "create_block_with_entry",
    {
      p_session_id: input.sessionId,
      p_client_id: input.clientId,
      p_block: blockFields,
      // 0129's create writes neither of these, so they are routed to the
      // strict allow-list writer instead of being silently dropped.
      p_block_extra: {
        block_notes: null,
        probe_inventory_item_id: inv.probeInventoryItemId,
      },
      // A brand-new block has no prior area rows, so an absent set and an empty
      // set mean the same thing here.
      p_areas: (areaRows ?? []).map((a, i) => ({
        area: a.area,
        laterality: a.laterality,
        display_order: i,
      })),
      // Create the first entry only when a treatment area is present. An
      // area-less, readings-less save creates just the block — a valid "set the
      // area up later" state, exactly as before.
      p_with_entry: Boolean(area),
      p_area: area,
      p_areas_list:
        areaRows && areaRows.length > 0 ? areaRows.map((sa) => sa.area) : area ? [area] : null,
      // The entry's own probe columns are not collected by this form; the
      // probe/inventory selection belongs to the BLOCK (blockFields above).
      p_probe_size: null,
      p_probe_lot_id: null,
      p_pulse_count: clampPulseCount(readings.pulseCount),
      p_pulse_delay_seconds: resolvePulseDelaySeconds(readings),
      p_comments: normalizedComments(readings),
      p_observation_chips: normalizedChips(readings),
      p_mode: snap.mode,
      p_apilus_modality: snap.apilus_modality,
      p_energy_level: snap.energy_level,
      p_minutes_performed: snap.minutes_performed,
      p_machine_frequency: snap.machine_frequency,
      p_probe_type: null,
      p_hairs_treated: readings.hairsTreated ?? null,
      p_galvanic_ma: readingCols.galvanic_ma,
      p_galvanic_duration_seconds: readingCols.galvanic_duration_seconds,
      p_thermolysis_intensity_percent: readingCols.thermolysis_intensity_percent,
      p_thermolysis_duration_seconds: readingCols.thermolysis_duration_seconds,
      p_units_of_lye: readingCols.units_of_lye,
    },
  );
  if (cmdErr) return { ok: false, error: mapBlockCommandError(cmdErr) };

  const createdBlockId = Array.isArray(createdRows)
    ? (createdRows[0] as { block_id?: string } | undefined)?.block_id
    : (createdRows as { block_id?: string } | null)?.block_id;
  if (!createdBlockId) return { ok: false, error: GENERIC_BLOCK_COMMAND_ERROR };

  const { data: blockRow, error: blockReadErr } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("id", createdBlockId)
    .single();
  if (blockReadErr || !blockRow) {
    return { ok: false, error: GENERIC_BLOCK_COMMAND_ERROR };
  }
  const block = blockRow as SessionBlock;

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
  // health-inspection client procedure record. Optional free text (the manual
  // path); DERIVED from the inventory row on the linked path.
  probeLotNumber?: string | null;
  // Migration 0155: the chosen sterile-inventory item id (durable link), or null
  // for a manual lot. Validated + snapshot-derived server-side.
  probeInventoryItemId?: string | null;
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
  // 0156: optional free-text numbing note (kept only when status is 'used').
  numbingNotes?: string | null;
  probeLotConfirmed?: boolean;
};

// L18 Phase 2: the block/entry atomicity exception that used to sit here is
// RETIRED.
// `update_block_with_entry` (migration 0166) now owns the block, its area rows
// and the coupled entry in ONE transaction. Previously the block update
// committed first and the entry followed with NO compensation, so a failed
// entry write left the two describing different treatments.
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

  // Read the block's currently-STORED link + snapshot (server-side, never from
  // the client) so an UNCHANGED inventory link preserves its frozen snapshot
  // instead of re-deriving from a since-edited inventory lot (contract #4/#7).
  // Fail safe on a read error rather than silently re-deriving (which would
  // defeat snapshot immutability).
  const { data: storedBlock, error: storedErr } = await supabase
    .from("session_blocks")
    .select("probe_key, probe_inventory_item_id, probe_lot_number")
    .eq("id", input.blockId)
    .eq("studio_id", studio.id)
    .eq("session_id", input.sessionId)
    .is("deleted_at", null)
    .maybeSingle();
  if (storedErr) {
    return { ok: false, error: "Could not load the settings block to save." };
  }

  // Migration 0155: resolve the probe-lot selection (see create action). When the
  // stored probe + inventory id are BOTH unchanged, the frozen snapshot is
  // preserved with no live re-validation (a later inventory edit/reclassification
  // never blocks an unrelated historical edit); otherwise the newly-selected link
  // is fully validated + a fresh snapshot derived. "Unchanged" is judged ONLY
  // against these server-loaded stored values, never a client claim.
  const inv = await resolveProbeInventorySelection(supabase, studio.id, {
    probeInventoryItemId: input.probeInventoryItemId ?? null,
    probeKey: probeCheck.columns.probe_key,
    manualLotNumber: input.probeLotNumber ?? null,
    probeLotConfirmed: Boolean(input.probeLotConfirmed),
    existingProbeKey: (storedBlock?.probe_key as string | null) ?? null,
    existingInventoryItemId:
      (storedBlock?.probe_inventory_item_id as string | null) ?? null,
    existingSnapshot: (storedBlock?.probe_lot_number as string | null) ?? null,
  });
  if (!inv.ok) return inv;

  // block_name / block_notes are intentionally omitted so any legacy value
  // is preserved. Machine settings + structured area + structured probe are
  // fully overwritten from the form (which holds all of them).
  const blockFields = {
    mode: input.mode ?? null,
    apilus_modality: input.apilusModality ?? null,
    energy_level: input.energyLevel ?? null,
    minutes_performed: input.minutesPerformed ?? null,
    machine_frequency: input.machineFrequency ?? null,
    probe_lot_number: inv.probeLotNumber,
    probe_inventory_item_id: inv.probeInventoryItemId,
    // Confirmation only counts when a lot is actually present.
    probe_lot_confirmed:
      Boolean(input.probeLotConfirmed) && (inv.probeLotNumber ?? "").trim() !== "",
    primary_area: blockPrimaryArea,
    side: blockSide,
    custom_area_detail: blockCustomDetail,
    ...probeCheck.columns,
    ...responseCheck.columns,
  };

  // L18 Phase 2: block + areas + coupled entry are now ONE transaction via
  // update_block_with_entry (migration 0166). Previously the block update
  // committed first and the entry followed with NO compensation, so a failed
  // entry write left the two describing different treatments. The
  // optimistic-concurrency token is forwarded unchanged, so a stale edit still
  // fails before anything is written.
  //
  // Entry shaping is unchanged: the same `entryMachineSnapshot` (galvanic
  // carries no apilus params) and the same mode-gated reading columns. Legacy
  // `intensity`/`duration_seconds` and an existing entry's `probe_type` /
  // `probe_size` / `probe_lot_id` are all preserved — the command's update
  // deliberately omits them, so old probe data is never wiped by an edit.
  const snap = entryMachineSnapshot({
    mode: (input.mode ?? null) as SessionMode | null,
    apilusModality: (input.apilusModality ?? null) as ApilusModality | null,
    energyLevel: input.energyLevel ?? null,
    minutesPerformed: input.minutesPerformed ?? null,
    machineFrequency: (input.machineFrequency ?? null) as MachineFrequency | null,
  });
  const readingCols = structuredReadingColumns(
    (input.mode ?? null) as SessionMode | null,
    readings,
  );
  // Update the first/primary entry when one exists; create it when the block had
  // none and readings are present. Entries 2..N stay exactly as-is.
  const updatingEntry = Boolean(input.firstEntryId);
  const creatingEntry = !updatingEntry && Boolean(area) && readingsPresent(readings);
  const { error: cmdErr } = await supabase.rpc("update_block_with_entry", {
    p_session_id: input.sessionId,
    p_client_id: input.clientId,
    p_block_id: input.blockId,
    p_block: blockFields,
    // 0129's update writes neither block_name nor probe_inventory_item_id.
    // block_name is not collected by this form, so it is left out entirely
    // (omitted keys are preserved); the inventory link is sent explicitly.
    p_block_extra: { probe_inventory_item_id: inv.probeInventoryItemId },
    // `areas` ABSENT (the legacy single-area edit path) sends NULL, which the
    // command reads as "leave the recorded area set exactly as it is". An
    // explicitly submitted set — including an empty one — replaces it.
    p_areas: areaRows
      ? areaRows.map((a, i) => ({
          area: a.area,
          laterality: a.laterality,
          display_order: i,
        }))
      : null,
    p_expected_updated_at: input.expectedUpdatedAt ?? null,
    p_with_entry: updatingEntry || creatingEntry,
    p_entry_id: input.firstEntryId ?? null,
    // The entry's area is re-keyed only when a treatment area is set; it is
    // never nulled, preserving a NOT NULL area if the block area was cleared.
    p_area: area ?? null,
    // On UPDATE the existing entry's `areas` mirrors the single treatment area,
    // as it always has; on CREATE it takes the full submitted set.
    p_areas_list: updatingEntry
      ? area
        ? [area]
        : null
      : areaRows && areaRows.length > 0
        ? areaRows.map((sa) => sa.area)
        : area
          ? [area]
          : null,
    p_probe_size: null,
    p_probe_lot_id: null,
    p_pulse_count: clampPulseCount(readings.pulseCount),
    p_pulse_delay_seconds: resolvePulseDelaySeconds(readings),
    p_comments: normalizedComments(readings),
    p_observation_chips: normalizedChips(readings),
    p_mode: snap.mode,
    p_apilus_modality: snap.apilus_modality,
    p_energy_level: snap.energy_level,
    p_minutes_performed: snap.minutes_performed,
    p_machine_frequency: snap.machine_frequency,
    p_probe_type: null,
    p_hairs_treated: readings.hairsTreated ?? null,
    p_galvanic_ma: readingCols.galvanic_ma,
    p_galvanic_duration_seconds: readingCols.galvanic_duration_seconds,
    p_thermolysis_intensity_percent: readingCols.thermolysis_intensity_percent,
    p_thermolysis_duration_seconds: readingCols.thermolysis_duration_seconds,
    p_units_of_lye: readingCols.units_of_lye,
  });
  if (cmdErr) {
    if (isStaleBlockVersion(cmdErr)) {
      return {
        ok: false,
        error:
          "This settings block was changed elsewhere. Reload the session and re-apply your edit.",
      };
    }
    return { ok: false, error: mapBlockCommandError(cmdErr) };
  }

  const { data: blockRow, error: blockReadErr } = await supabase
    .from("session_blocks")
    .select("*")
    .eq("id", input.blockId)
    .single();
  if (blockReadErr || !blockRow) {
    return { ok: false, error: GENERIC_BLOCK_COMMAND_ERROR };
  }
  const block = blockRow as SessionBlock;

  await rememberMachineFrequencyDefault(
    practitioner.id,
    (input.machineFrequency ?? null) as MachineFrequency | null,
  );
  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return { ok: true, block: block as SessionBlock };
}
