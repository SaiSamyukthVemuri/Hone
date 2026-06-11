"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { getCurrentPractitionerWithStudio } from "@/lib/supabase/queries";
import { findProbeOptionByKey } from "@/lib/probes";
import {
  isReactionType,
  isToleranceRating,
  type ReactionType,
} from "@/lib/sessions/clinical-response";
import {
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
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
};

type ClinicalResponseColumns = {
  tolerance_rating: number | null;
  reaction_type: ReactionType | null;
  reaction_notes: string | null;
  caution_for_next_session: boolean;
  caution_note: string | null;
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
  return {
    ok: true,
    columns: {
      tolerance_rating: rating,
      reaction_type: reaction,
      reaction_notes: reactionNotes,
      caution_for_next_session: cautionFlag,
      caution_note: cautionNote,
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
  // Session Logging Phase B — optional structured probe (catalog key).
  // Validated + decomposed server-side. Empty/absent → no structured probe.
  probeOptionKey?: string | null;
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
  let normalizedPatch: Partial<SessionBlock> = patch;
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
  await assertSessionInStudio(studio.id, input.sessionId);

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

  const rows = prevBlocks.map((b, i) => ({
    studio_id: studio.id,
    session_id: input.sessionId,
    sort_order: i + 1,
    block_name: b.block_name,
    primary_area: b.primary_area,
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
  }));

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
  hairsTreated?: number | null;
  comments?: string | null;
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
    (typeof r.comments === "string" && r.comments.trim().length > 0)
  );
}

function normalizedComments(r: EntryReadingsInput): string | null {
  return typeof r.comments === "string" && r.comments.trim().length > 0
    ? r.comments.trim()
    : null;
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
  machineFrequency?: MachineFrequency | null;
  primaryArea?: string | null;
  side?: string | null;
  customAreaDetail?: string | null;
  readings?: EntryReadingsInput;
  // PR #190 (migration 0082): structured client response, all optional.
  toleranceRating?: number | null;
  reactionType?: string | null;
  reactionNotes?: string | null;
  cautionForNextSession?: boolean;
  cautionNote?: string | null;
};

export async function createTreatmentAreaWithEntryAction(
  input: CreateAreaWithEntryInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot log sessions." };
  }
  await assertSessionInStudio(studio.id, input.sessionId);

  const areaCheck = normalizeStructuredArea({
    primaryArea: input.primaryArea ?? null,
    side: input.side ?? null,
    customAreaDetail: input.customAreaDetail ?? null,
  });
  if (!areaCheck.ok) return areaCheck;

  const probeCheck = resolveStructuredProbe(input.probeOptionKey);
  if (!probeCheck.ok) return probeCheck;

  const responseCheck = normalizeClinicalResponse(input);
  if (!responseCheck.ok) return responseCheck;

  const readings = input.readings ?? {};
  const area = areaCheck.value.primary_area;

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

  const { data: block, error: blockErr } = await supabase
    .from("session_blocks")
    .insert({
      studio_id: studio.id,
      session_id: input.sessionId,
      sort_order: nextSort,
      block_name: null,
      mode: input.mode ?? null,
      apilus_modality: input.apilusModality ?? null,
      energy_level: input.energyLevel ?? null,
      minutes_performed: input.minutesPerformed ?? null,
      machine_frequency: input.machineFrequency ?? null,
      primary_area: areaCheck.value.primary_area,
      side: areaCheck.value.side,
      custom_area_detail: areaCheck.value.custom_area_detail,
      ...probeCheck.columns,
      ...responseCheck.columns,
    })
    .select("*")
    .single();
  if (blockErr) return { ok: false, error: blockErr.message };

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
        areas: [area],
        probe_lot_id: null,
        // Legacy generic intensity / duration_seconds are intentionally not
        // written; thermolysis / galvanic readings live in their own columns.
        pulse_count: clampPulseCount(readings.pulseCount),
        hairs_treated: readings.hairsTreated ?? null,
        comments: normalizedComments(readings),
        ...structuredReadingColumns((input.mode ?? null) as SessionMode | null, readings),
        ...snap,
      });
    if (entryErr) {
      // Cleanup: remove the just-created block so its minutes_performed
      // can't pollute TTT and no orphan treatment area is left behind. The
      // block is brand-new with no other entries, so a hard delete is safe.
      await supabase
        .from("session_blocks")
        .delete()
        .eq("id", block.id)
        .eq("studio_id", studio.id);
      return {
        ok: false,
        error: `Failed to save treatment details: ${entryErr.message}`,
      };
    }
  }

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
  mode?: SessionMode | null;
  apilusModality?: ApilusModality | null;
  energyLevel?: number | null;
  minutesPerformed?: number | null;
  probeOptionKey?: string | null;
  machineFrequency?: MachineFrequency | null;
  primaryArea?: string | null;
  side?: string | null;
  customAreaDetail?: string | null;
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
};

export async function updateTreatmentAreaWithEntryAction(
  input: UpdateAreaWithEntryInput,
): Promise<BlockResult> {
  const { practitioner, studio } = await getCurrentPractitionerWithStudio();
  if (!practitioner.active) {
    return { ok: false, error: "Inactive practitioners cannot edit sessions." };
  }
  await assertSessionInStudio(studio.id, input.sessionId);

  const areaCheck = normalizeStructuredArea({
    primaryArea: input.primaryArea ?? null,
    side: input.side ?? null,
    customAreaDetail: input.customAreaDetail ?? null,
  });
  if (!areaCheck.ok) return areaCheck;

  const probeCheck = resolveStructuredProbe(input.probeOptionKey);
  if (!probeCheck.ok) return probeCheck;

  const responseCheck = normalizeClinicalResponse(input);
  if (!responseCheck.ok) return responseCheck;

  const readings = input.readings ?? {};
  const area = areaCheck.value.primary_area;

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
  const { data: block, error: blockErr } = await supabase
    .from("session_blocks")
    .update({
      mode: input.mode ?? null,
      apilus_modality: input.apilusModality ?? null,
      energy_level: input.energyLevel ?? null,
      minutes_performed: input.minutesPerformed ?? null,
      machine_frequency: input.machineFrequency ?? null,
      primary_area: areaCheck.value.primary_area,
      side: areaCheck.value.side,
      custom_area_detail: areaCheck.value.custom_area_detail,
      ...probeCheck.columns,
      ...responseCheck.columns,
    })
    .eq("id", input.blockId)
    .eq("studio_id", studio.id)
    .eq("session_id", input.sessionId)
    .is("deleted_at", null)
    .select("*")
    .single();
  if (blockErr) return { ok: false, error: blockErr.message };

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
      hairs_treated: readings.hairsTreated ?? null,
      comments: normalizedComments(readings),
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
        areas: [area],
        probe_lot_id: null,
        pulse_count: clampPulseCount(readings.pulseCount),
        hairs_treated: readings.hairsTreated ?? null,
        comments: normalizedComments(readings),
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

  revalidatePath(`/clients/${input.clientId}/sessions/${input.sessionId}`);
  revalidatePath(`/clients/${input.clientId}`);
  return { ok: true, block: block as SessionBlock };
}
