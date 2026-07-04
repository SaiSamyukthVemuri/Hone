"use client";

// Treatment-area editor for an electrolysis session.
//
// Session Logging Phase A: practitioner-facing language is "treatment
// area," not "block." The underlying schema (session_blocks) and the
// create/update server actions are unchanged — this is an area-first UI
// over the existing fields:
//   - Treatment area (primary_area / side / custom_area_detail, 0039) is
//     the section identity and comes first.
//   - block_name is NOT collected in this flow. New areas save with a
//     null block_name; legacy rows keep their block_name (we never send
//     it in the edit patch, so it's preserved).
//   - Minutes performed is optional: session_blocks.minutes_performed is
//     nullable and createSessionBlockAction defaults blank → null, so a
//     blank field saves as null (not 0).
//
// Dual mode: with `block` it edits that row via updateSessionBlockAction;
// without, it creates a new row via createSessionBlockAction. Both
// actions already accept every field used here — no action behavior
// change.

import { useState, useTransition } from "react";
import {
  APILUS_MODALITIES_BY_MODE,
  COMMON_COMMENTS,
  ELECTROLYSIS_MODES,
  MACHINE_FREQUENCIES,
  PULSE_COUNT_DEFAULT,
  PULSE_COUNT_MAX,
  PULSE_COUNT_MIN,
  PULSE_DELAY_DEFAULT,
  PULSE_DELAY_MIN,
  PULSE_DELAY_MAX,
  apilusModalityLabel,
} from "@/lib/constants";
import {
  PROBE_BRANDS,
  findProbeOptionByKey,
  getMaterialsForBrand,
  getProbeOptionsFor,
  type ProbeBrand,
  type ProbeMaterial,
} from "@/lib/probes";
import type {
  ApilusModality,
  ElectrolysisEntry,
  ElectrolysisMode,
  MachineFrequency,
  SessionBlock,
  SessionBlockSide,
  SessionMode,
} from "@/lib/types/database";
import { isCommentSelected, toggleComment } from "@/lib/comments";
import {
  NUMBING_OPTIONS,
  REACTION_TYPES,
  TOLERANCE_OPTIONS,
  reactionTypeLabel,
} from "@/lib/sessions/clinical-response";
import { SESSION_BLOCK_SIDE_OPTIONS } from "@/lib/sessions/side-labels";
import { AreaPicker } from "@/components/area-picker";
import { BodyMapAreaPicker } from "@/components/body-map-area-picker";
import {
  createTreatmentAreaWithEntryAction,
  updateTreatmentAreaWithEntryAction,
} from "./block-actions";

const PRIMARY_AREA_MAX = 60;
const CUSTOM_AREA_DETAIL_MAX = 60;
const MINUTES_MAX = 1440;

const READING_INPUT_CLS =
  "rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950";

// Parses an optional numeric reading with range checks. Empty → null.
// Mirrors the server-side validation; the action re-validates regardless.
function parseOptionalNumber(
  raw: string,
  opts: { int?: boolean; min?: number; max?: number; label: string },
): { ok: true; value: number | null } | { ok: false; error: string } {
  const s = raw.trim();
  if (s === "") return { ok: true, value: null };
  const n = opts.int ? parseInt(s, 10) : Number(s);
  if (!Number.isFinite(n)) {
    return { ok: false, error: `${opts.label} must be a number.` };
  }
  if (opts.min != null && n < opts.min) {
    return { ok: false, error: `${opts.label} must be ${opts.min} or more.` };
  }
  if (opts.max != null && n > opts.max) {
    return { ok: false, error: `${opts.label} must be ${opts.max} or less.` };
  }
  return { ok: true, value: n };
}

// Side options for paired anatomy. The DB CHECK (migration 0039) enforces
// the same five values plus NULL. UI displays a Title-case label but
// stores the canonical lowercase value. PR #162 moved the option list +
// label-lookup into lib/sessions/side-labels.ts so the read-only blocks
// view picks up the same wording (notably "bilateral" -> "Both sides"
// after Chloe's charting feedback). We re-export the alias here so the
// rest of this file (which references SIDE_OPTIONS in two render sites)
// continues to compile without a wider rename.
const SIDE_OPTIONS = SESSION_BLOCK_SIDE_OPTIONS;

type Props = {
  sessionId: string;
  clientId: string;
  // For "Copy settings from another area in this session" (create mode only).
  previousBlock: SessionBlock | null;
  // PR #191: every saved treatment area in this session, in sort
  // order. Copy settings prefers the most recent area matching the
  // currently selected treatment area before falling back to the
  // last one.
  savedBlocks?: SessionBlock[];
  // When present, the form edits this existing area instead of creating.
  block?: SessionBlock | null;
  // The block's first/primary entry, if any. In edit mode its readings seed
  // the form and are updated on save; entries 2..N are never touched here.
  firstEntry?: ElectrolysisEntry | null;
  // Create-mode only: initial value for the treatment area, seeded from the
  // attached treatment plan's primary_area. UI defaulting only — fully
  // editable; never overrides the practitioner's choice on save.
  defaultPrimaryArea?: string | null;
  // Create-mode only (PR #203, migration 0084): sticky machine
  // frequency seeded from the practitioner's last-used value. UI
  // defaulting only; fully editable per treatment area.
  defaultMachineFrequency?: string | null;
  // PR #279 (Chloe charting feedback): latest current probe lot/batch from the
  // sterile-item records, offered for the practitioner to CONFIRM (never
  // auto-saved). Null when there is nothing to suggest.
  suggestedProbeLot?: string | null;
  onCancel: () => void;
};

type Draft = {
  mode: string;
  apilusModality: string;
  energyLevel: string;
  // Session Logging Phase B: a single structured probe catalog key
  // (lib/probes.ts). Empty string = no probe. Replaces the old flat
  // probeType / probeSize dropdowns.
  probeKey: string;
  probeLotNumber: string;
  machineFrequency: string;
  minutes: string;
  // Treatment area (0039). All optional; empty → null on save.
  primaryArea: string;
  side: string; // SessionBlockSide | ""
  customAreaDetail: string;
  // One-page charting: the first entry's readings, captured on the same
  // page and saved with the treatment area (no second form). Phase 3 splits
  // the readings into thermolysis and galvanic so blend records both.
  thermolysisIntensityPercent: string;
  thermolysisDurationSeconds: string;
  galvanicMa: string;
  galvanicDurationSeconds: string;
  galvanicIntensityPercent: string;
  unitsOfLye: string;
  pulseCount: string;
  pulseDelay: string;
  hairsTreated: string;
  comments: string;
  // PR #190 (migration 0082): structured client response. All optional.
  // toleranceRating is "" or "1".."5"; reactionType is "" or an
  // allowlisted value from lib/sessions/clinical-response.ts.
  toleranceRating: string;
  reactionType: string;
  reactionNotes: string;
  cautionForNextSession: boolean;
  cautionNote: string;
  // PR #279 (migration 0095). numbingStatus is "" (Not recorded), "none", or
  // "used". probeLotConfirmed records that the practitioner confirmed the lot.
  numbingStatus: string;
  probeLotConfirmed: boolean;
};

const EMPTY: Draft = {
  mode: "",
  apilusModality: "",
  energyLevel: "",
  probeKey: "",
  probeLotNumber: "",
  machineFrequency: "",
  minutes: "",
  primaryArea: "",
  side: "",
  customAreaDetail: "",
  thermolysisIntensityPercent: "",
  thermolysisDurationSeconds: "",
  galvanicMa: "",
  galvanicDurationSeconds: "",
  galvanicIntensityPercent: "",
  unitsOfLye: "",
  pulseCount: String(PULSE_COUNT_DEFAULT),
  pulseDelay: String(PULSE_DELAY_DEFAULT),
  hairsTreated: "",
  comments: "",
  toleranceRating: "",
  reactionType: "",
  reactionNotes: "",
  cautionForNextSession: false,
  cautionNote: "",
  numbingStatus: "",
  probeLotConfirmed: false,
};

function initialDraft(
  block: SessionBlock | null | undefined,
  firstEntry: ElectrolysisEntry | null | undefined,
  defaultPrimaryArea: string | null | undefined,
  defaultMachineFrequency?: string | null,
): Draft {
  // Create mode: start blank, but seed the treatment area from the attached
  // plan when provided, and the machine frequency from the practitioner's
  // sticky last-used default (PR #203, migration 0084). Both editable;
  // never forced.
  if (!block) {
    return {
      ...EMPTY,
      primaryArea: defaultPrimaryArea?.trim() || "",
      machineFrequency: defaultMachineFrequency?.trim() || "",
    };
  }
  return {
    mode: block.mode ?? "",
    apilusModality: block.apilus_modality ?? "",
    energyLevel: block.energy_level != null ? String(block.energy_level) : "",
    probeKey: block.probe_key ?? "",
    probeLotNumber: block.probe_lot_number ?? "",
    machineFrequency: block.machine_frequency ?? "",
    minutes:
      block.minutes_performed != null ? String(block.minutes_performed) : "",
    primaryArea: block.primary_area ?? "",
    side: block.side ?? "",
    customAreaDetail: block.custom_area_detail ?? "",
    // Seed readings from the first entry if present; otherwise blank (and
    // pulse defaults to 1, matching a fresh pass).
    thermolysisIntensityPercent:
      firstEntry?.thermolysis_intensity_percent != null
        ? String(firstEntry.thermolysis_intensity_percent)
        : "",
    thermolysisDurationSeconds:
      firstEntry?.thermolysis_duration_seconds != null
        ? String(firstEntry.thermolysis_duration_seconds)
        : "",
    galvanicMa:
      firstEntry?.galvanic_ma != null ? String(firstEntry.galvanic_ma) : "",
    galvanicDurationSeconds:
      firstEntry?.galvanic_duration_seconds != null
        ? String(firstEntry.galvanic_duration_seconds)
        : "",
    galvanicIntensityPercent:
      firstEntry?.galvanic_intensity_percent != null
        ? String(firstEntry.galvanic_intensity_percent)
        : "",
    unitsOfLye:
      firstEntry?.units_of_lye != null ? String(firstEntry.units_of_lye) : "",
    pulseCount:
      firstEntry?.pulse_count != null
        ? String(firstEntry.pulse_count)
        : String(PULSE_COUNT_DEFAULT),
    pulseDelay:
      firstEntry?.pulse_delay_seconds != null
        ? String(firstEntry.pulse_delay_seconds)
        : String(PULSE_DELAY_DEFAULT),
    hairsTreated:
      firstEntry?.hairs_treated != null
        ? String(firstEntry.hairs_treated)
        : "",
    comments: firstEntry?.comments ?? "",
    // PR #190: round-trip the stored response so an edit save that
    // never touches the section preserves it unchanged.
    toleranceRating:
      block.tolerance_rating != null ? String(block.tolerance_rating) : "",
    reactionType: block.reaction_type ?? "",
    reactionNotes: block.reaction_notes ?? "",
    cautionForNextSession: block.caution_for_next_session ?? false,
    cautionNote: block.caution_note ?? "",
    // PR #279 (migration 0095): round-trip numbing + lot confirmation.
    numbingStatus: block.numbing_status ?? "",
    probeLotConfirmed: block.probe_lot_confirmed ?? false,
  };
}

export function BlockSetupForm({
  sessionId,
  clientId,
  previousBlock,
  savedBlocks,
  block,
  firstEntry,
  defaultPrimaryArea,
  defaultMachineFrequency,
  suggestedProbeLot = null,
  onCancel,
}: Props) {
  const isEdit = !!block;
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(block, firstEntry, defaultPrimaryArea, defaultMachineFrequency),
  );
  const [error, setError] = useState<string | null>(null);
  // PR #191: inline feedback after "Copy settings" so the
  // practitioner knows what was copied and from where.
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // Treatment-area picker is collapsed to a compact summary when an area is
  // already selected (e.g. seeded from the plan, or in edit mode); the full
  // region-grouped picker only expands when there's no area yet or the
  // practitioner taps "Change".
  const [editingArea, setEditingArea] = useState(
    () => !(draft.primaryArea.trim().length > 0),
  );

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // PR #270: single area-change handler shared by the body map and the
  // list-below AreaPicker, so both write the same primary_area and clearing
  // the area also clears side + specifics (no orphan side).
  function onAreaChange(next: string) {
    if (!next) {
      setDraft((d) => ({ ...d, primaryArea: "", side: "", customAreaDetail: "" }));
    } else {
      update("primaryArea", next);
    }
  }

  // "Copy settings from another area in this session" (PR #191 rework after
  // Chloe's smoke). Copies the FULL treatment configuration a
  // practitioner expects: mode, modality, energy, machine frequency,
  // probe, and minutes. Never the area identity (the practitioner
  // chooses the new area fresh) and never the client response
  // (tolerance / reaction / caution belong to the treatment that
  // already happened, not the one being set up). Area-aware: when a
  // treatment area is already selected and this session has a saved
  // area with the same name, that area's settings win over the most
  // recent one; the inline message says exactly what was copied.
  function copySettings() {
    const candidates = (savedBlocks && savedBlocks.length > 0
      ? savedBlocks
      : previousBlock
        ? [previousBlock]
        : []
    ).filter((b) => !block || b.id !== block.id);
    if (candidates.length === 0) {
      setCopyMessage("No previous treatment area to copy from.");
      return;
    }
    const wantedArea = draft.primaryArea.trim().toLowerCase();
    const areaMatch = wantedArea
      ? [...candidates]
          .reverse()
          .find((b) => (b.primary_area ?? "").trim().toLowerCase() === wantedArea)
      : undefined;
    const source = areaMatch ?? candidates[candidates.length - 1];
    setDraft((d) => ({
      ...d,
      mode: source.mode ?? "",
      apilusModality: source.apilus_modality ?? "",
      energyLevel:
        source.energy_level != null ? String(source.energy_level) : "",
      probeKey: source.probe_key ?? "",
      machineFrequency: source.machine_frequency ?? "",
      minutes:
        source.minutes_performed != null
          ? String(source.minutes_performed)
          : "",
    }));
    const sourceName = source.primary_area?.trim() || source.block_name?.trim();
    if (areaMatch) {
      setCopyMessage(
        `Copied settings from the ${sourceName ?? "matching"} area in this session.`,
      );
    } else if (wantedArea && sourceName) {
      setCopyMessage(
        `No earlier ${draft.primaryArea.trim()} settings in this session; copied from ${sourceName}.`,
      );
    } else {
      setCopyMessage(
        sourceName
          ? `Copied settings from ${sourceName} in this session.`
          : "Copied settings from the previous area in this session.",
      );
    }
  }

  function submit() {
    setError(null);
    const el = draft.energyLevel.trim();
    const elNum = el === "" ? null : Number(el);
    if (el !== "" && (!Number.isFinite(elNum) || (elNum as number) < 0)) {
      setError("Energy level must be a non-negative number.");
      return;
    }
    const min = draft.minutes.trim();
    const minutesNum = min === "" ? null : parseInt(min, 10);
    if (
      min !== "" &&
      (!Number.isFinite(minutesNum) ||
        (minutesNum as number) < 0 ||
        (minutesNum as number) > MINUTES_MAX)
    ) {
      setError(`Minutes must be between 0 and ${MINUTES_MAX}.`);
      return;
    }
    const trimmedArea = draft.primaryArea.trim();
    if (trimmedArea.length > PRIMARY_AREA_MAX) {
      setError(`Treatment area must be ${PRIMARY_AREA_MAX} characters or fewer.`);
      return;
    }
    const trimmedDetail = draft.customAreaDetail.trim();
    if (trimmedDetail.length > CUSTOM_AREA_DETAIL_MAX) {
      setError(`Specifics must be ${CUSTOM_AREA_DETAIL_MAX} characters or fewer.`);
      return;
    }

    // Readings (the first pass). All optional except pulse, which defaults
    // to 1. Light client-side range checks; the action re-validates and
    // also nulls fields that don't apply to the chosen mode.
    const tInt = parseOptionalNumber(draft.thermolysisIntensityPercent, {
      int: true,
      min: 0,
      max: 100,
      label: "Thermolysis intensity",
    });
    if (!tInt.ok) return setError(tInt.error);
    // PR #165. Drop int: true so the parser preserves fractional
    // seconds like 0.15 / 0.2. Migration 0071 widened the DB
    // column to numeric so the round trip is now lossless.
    const tDur = parseOptionalNumber(draft.thermolysisDurationSeconds, {
      min: 0,
      label: "Thermolysis duration",
    });
    if (!tDur.ok) return setError(tDur.error);
    const gMa = parseOptionalNumber(draft.galvanicMa, {
      min: 0,
      label: "Galvanic mA",
    });
    if (!gMa.ok) return setError(gMa.error);
    const gDur = parseOptionalNumber(draft.galvanicDurationSeconds, {
      int: true,
      min: 0,
      label: "Galvanic duration",
    });
    if (!gDur.ok) return setError(gDur.error);
    const gInt = parseOptionalNumber(draft.galvanicIntensityPercent, {
      int: true,
      min: 0,
      max: 100,
      label: "Galvanic intensity",
    });
    if (!gInt.ok) return setError(gInt.error);
    const ul = parseOptionalNumber(draft.unitsOfLye, {
      min: 0,
      label: "Units of lye",
    });
    if (!ul.ok) return setError(ul.error);
    const hairs = parseOptionalNumber(draft.hairsTreated, {
      int: true,
      min: 0,
      label: "Total hairs treated",
    });
    if (!hairs.ok) return setError(hairs.error);
    const pulseStr = draft.pulseCount.trim();
    const pulseCount = pulseStr === "" ? null : parseInt(pulseStr, 10);
    // Pulse delay is only recorded when multiple pulses were done. When
    // applicable, validate the range here so the practitioner gets the exact
    // message; the server re-validates (defense-in-depth).
    let pulseDelaySeconds: number | null = null;
    if (pulseCount != null && pulseCount > 1 && draft.pulseDelay.trim() !== "") {
      const pd = Number(draft.pulseDelay);
      if (!Number.isFinite(pd) || pd < PULSE_DELAY_MIN || pd > PULSE_DELAY_MAX) {
        return setError("Pulse delay must be between 0.03 and 1.90 seconds.");
      }
      pulseDelaySeconds = Math.round(pd * 100) / 100;
    }

    // PR #190: structured client response, shared by create + edit.
    const clinicalResponse = {
      toleranceRating: draft.toleranceRating
        ? parseInt(draft.toleranceRating, 10)
        : null,
      reactionType: draft.reactionType || null,
      reactionNotes: draft.reactionNotes.trim() || null,
      cautionForNextSession: draft.cautionForNextSession,
      cautionNote: draft.cautionNote.trim() || null,
      // PR #279: numbing record ("" -> Not recorded -> null in the action).
      numbingStatus: draft.numbingStatus || null,
    };

    const readings = {
      thermolysisIntensityPercent: tInt.value,
      thermolysisDurationSeconds: tDur.value,
      galvanicMa: gMa.value,
      galvanicDurationSeconds: gDur.value,
      galvanicIntensityPercent: gInt.value,
      unitsOfLye: ul.value,
      pulseCount,
      pulseDelaySeconds,
      hairsTreated: hairs.value,
      comments: draft.comments,
    };

    startTransition(async () => {
      if (block) {
        // Edit: update the treatment area + its first entry's readings.
        // block_name/block_notes are preserved (the combined action never
        // writes them); entries 2..N are untouched.
        const res = await updateTreatmentAreaWithEntryAction({
          clientId,
          sessionId,
          blockId: block.id,
          firstEntryId: firstEntry?.id ?? null,
          mode: (draft.mode || null) as SessionMode | null,
          apilusModality: (draft.apilusModality || null) as
            | ApilusModality
            | null,
          energyLevel: elNum,
          minutesPerformed: minutesNum,
          probeOptionKey: draft.probeKey || null,
          probeLotNumber: draft.probeLotNumber.trim() || null,
          probeLotConfirmed: draft.probeLotConfirmed,
          machineFrequency: (draft.machineFrequency || null) as
            | MachineFrequency
            | null,
          primaryArea: trimmedArea || null,
          side: draft.side || null,
          customAreaDetail: trimmedDetail || null,
          readings,
          ...clinicalResponse,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        onCancel();
        return;
      }
      // Create: one save → treatment area + first entry. block_name omitted
      // (null) — the section title falls back to the area, then a muted
      // placeholder.
      const res = await createTreatmentAreaWithEntryAction({
        clientId,
        sessionId,
        mode: (draft.mode || null) as ElectrolysisMode | null,
        apilusModality: (draft.apilusModality || null) as ApilusModality | null,
        energyLevel: elNum,
        minutesPerformed: minutesNum,
        probeOptionKey: draft.probeKey || null,
        probeLotNumber: draft.probeLotNumber.trim() || null,
        probeLotConfirmed: draft.probeLotConfirmed,
        machineFrequency: (draft.machineFrequency || null) as
          | MachineFrequency
          | null,
        primaryArea: trimmedArea || null,
        side: draft.side || null,
        customAreaDetail: trimmedDetail || null,
        readings,
        ...clinicalResponse,
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onCancel();
    });
  }

  function bumpPulse(delta: number) {
    const current = parseInt(draft.pulseCount, 10);
    const base = Number.isFinite(current) ? current : PULSE_COUNT_DEFAULT;
    const next = Math.min(
      PULSE_COUNT_MAX,
      Math.max(PULSE_COUNT_MIN, base + delta),
    );
    update("pulseCount", String(next));
  }

  const mode = draft.mode;
  const showModality = mode === "thermo" || mode === "blend";
  const modalityOptions =
    mode === "thermo"
      ? APILUS_MODALITIES_BY_MODE.thermo
      : mode === "blend"
        ? APILUS_MODALITIES_BY_MODE.blend
        : [];

  // PR #279 (Chloe charting feedback): OmniBlend-specific reading layout. For
  // OmniBlend the galvanic settings are charted BEFORE thermolysis, OmniBlend
  // thermolysis has no duration, and galvanic has no intensity. Other modalities
  // are intentionally NOT changed (pending Chloe's review of the rest). Hiding an
  // input never clears a stored value — an existing reading round-trips on save,
  // so historical OmniBlend records are not rewritten; new ones leave it empty.
  const isOmniblend = draft.apilusModality === "Omniblend";

  const thermoSection =
    mode === "thermo" || mode === "blend" ? (
      <div className="flex flex-col gap-3">
        {mode === "blend" && (
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Thermolysis
          </span>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          {!isOmniblend && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">
                Thermolysis duration (s)
              </span>
              <input
                type="number"
                inputMode="decimal"
                step="0.01"
                min={0}
                value={draft.thermolysisDurationSeconds}
                onChange={(e) =>
                  update("thermolysisDurationSeconds", e.target.value)
                }
                className={READING_INPUT_CLS}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Thermolysis intensity %</span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min={0}
              max={100}
              value={draft.thermolysisIntensityPercent}
              onChange={(e) =>
                update("thermolysisIntensityPercent", e.target.value)
              }
              className={READING_INPUT_CLS}
            />
          </label>
        </div>
      </div>
    ) : null;

  const galvSection =
    mode === "galv" || mode === "blend" ? (
      <div className="flex flex-col gap-3">
        {mode === "blend" && (
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Galvanic
          </span>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Galvanic mA</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              value={draft.galvanicMa}
              onChange={(e) => update("galvanicMa", e.target.value)}
              className={READING_INPUT_CLS}
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Galvanic duration (s)</span>
            <input
              type="number"
              inputMode="numeric"
              step="1"
              min={0}
              value={draft.galvanicDurationSeconds}
              onChange={(e) =>
                update("galvanicDurationSeconds", e.target.value)
              }
              className={READING_INPUT_CLS}
            />
          </label>
          {!isOmniblend && (
            <label className="flex flex-col gap-1.5">
              <span className="text-sm font-medium">Galvanic intensity %</span>
              <input
                type="number"
                inputMode="numeric"
                step="1"
                min={0}
                max={100}
                value={draft.galvanicIntensityPercent}
                onChange={(e) =>
                  update("galvanicIntensityPercent", e.target.value)
                }
                className={READING_INPUT_CLS}
              />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Units of lye (UL)</span>
            <input
              type="number"
              inputMode="decimal"
              step="0.1"
              min={0}
              value={draft.unitsOfLye}
              onChange={(e) => update("unitsOfLye", e.target.value)}
              className={READING_INPUT_CLS}
            />
          </label>
        </div>
      </div>
    ) : null;

  return (
    <div className="flex flex-col gap-5 rounded-lg border border-neutral-200 bg-white p-5 dark:border-neutral-800 dark:bg-neutral-950">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-base font-medium">
          {isEdit ? "Edit treatment area" : "New treatment area"}
        </h3>
        {!isEdit && previousBlock && (
          <button
            type="button"
            onClick={copySettings}
            disabled={pending}
            className="rounded-md border border-neutral-300 px-3 py-1.5 text-xs font-medium hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
          >
            Copy settings from another area in this session
          </button>
        )}
      </div>
      {copyMessage && (
        <p className="text-xs text-neutral-600 dark:text-neutral-400" role="status">
          {copyMessage}
        </p>
      )}

      {/* Treatment area first — it's the identity of this section. When an
          area is already selected it collapses to a compact summary with a
          "Change" affordance; the full region-grouped picker only expands
          when there's no area yet or the practitioner taps Change. */}
      {/* PR #269: Visual treatment-area chart part. The region-grouped
          AreaPicker (chips) is framed as a distinct "chart part" card with a
          live "Area being charted" preview, so area selection reads as a
          visual chart part rather than a plain field. Reuses the existing
          structured fields (primary_area / side / custom_area_detail); no
          schema change, no image/upload/canvas. */}
      <div className="flex flex-col gap-2 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
        <div className="flex flex-col gap-0.5">
          <span className="text-[10px] font-medium uppercase tracking-wider text-neutral-400">
            Chart part
          </span>
          <span className="text-sm font-medium">Treatment area</span>
        </div>

        {draft.primaryArea.trim().length > 0 && !editingArea ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-neutral-500">Area being charted:</span>
            <span className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
              {draft.primaryArea}
              {draft.side && draft.side !== "n/a"
                ? ` · ${SIDE_OPTIONS.find((o) => o.value === draft.side)?.label ?? draft.side}`
                : ""}
              {draft.customAreaDetail.trim()
                ? ` · ${draft.customAreaDetail.trim()}`
                : ""}
            </span>
            <button
              type="button"
              onClick={() => setEditingArea(true)}
              className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
            >
              Change
            </button>
          </div>
        ) : (
          <>
            <span className="text-xs text-neutral-500">
              Choose from the body map or use the list below. Optional; side and
              specifics appear once an area is chosen.
            </span>

            {/* PR #270: built-in body-map picker (schematic vector body, not an
                image/upload/canvas). Sets the same primary_area value as the
                list-below AreaPicker via the shared onAreaChange handler. */}
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Body map
              </span>
              <BodyMapAreaPicker
                value={draft.primaryArea}
                onChange={onAreaChange}
                idPrefix={`area-${block?.id ?? "new"}-${sessionId}`}
              />
            </div>

            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                Or choose from the list
              </span>
              <AreaPicker
                value={draft.primaryArea}
                onChange={onAreaChange}
                idPrefix={`area-${block?.id ?? "new"}-${sessionId}`}
              />
            </div>

            {/* PR #269: live preview of the chart part's area, updating as the
                practitioner picks area / side / specifics. */}
            <p className="pt-1 text-sm">
              <span className="text-neutral-500">Area being charted: </span>
              {draft.primaryArea.trim() ? (
                <span className="font-medium">
                  {draft.primaryArea.trim()}
                  {draft.side && draft.side !== "n/a"
                    ? ` · ${SIDE_OPTIONS.find((o) => o.value === draft.side)?.label ?? draft.side}`
                    : ""}
                  {draft.customAreaDetail.trim()
                    ? ` · ${draft.customAreaDetail.trim()}`
                    : ""}
                </span>
              ) : (
                <span className="text-neutral-400">Area not recorded</span>
              )}
            </p>

            {draft.primaryArea.trim().length > 0 && (
              <>
                <div className="flex flex-col gap-1.5 pt-1">
                  <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                    Side
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {SIDE_OPTIONS.map((opt) => {
                      const selected = draft.side === opt.value;
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          onClick={() => update("side", selected ? "" : opt.value)}
                          aria-pressed={selected}
                          className={
                            // PR #235: px-3 py-1.5 (was px-2.5 py-1) so the side chips
                          // are comfortable touch targets on phones.
                          "rounded-full border px-3 py-1.5 text-xs " +
                            (selected
                              ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                              : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300")
                          }
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <label className="flex flex-col gap-1.5 pt-1">
                  <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
                    Specifics
                  </span>
                  <input
                    type="text"
                    value={draft.customAreaDetail}
                    onChange={(e) => update("customAreaDetail", e.target.value)}
                    placeholder="midline, under-chin, knuckles, jawline edge…"
                    maxLength={CUSTOM_AREA_DETAIL_MAX}
                    className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                </label>

                <button
                  type="button"
                  onClick={() => setEditingArea(false)}
                  className="self-start text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
                >
                  Done
                </button>
              </>
            )}
          </>
        )}
      </div>

      {/* Machine settings come after the area, in Chloe's charting
          order (PR #204): frequency (a property of the machine),
          then probe, then mode and the mode-specific modality.
          Minutes performed moved to the end, after the readings. */}
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Machine frequency</span>
        <div className="flex flex-wrap gap-2">
          {MACHINE_FREQUENCIES.map((f) => {
            const selected = draft.machineFrequency === f;
            return (
              <button
                key={f}
                type="button"
                onClick={() =>
                  update("machineFrequency", selected ? "" : (f as string))
                }
                className={`rounded-full border px-4 py-2 text-sm transition ${
                  selected
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }`}
              >
                {f}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Probe</span>
        <span className="text-xs text-neutral-500">
          Optional. Used for accurate electrolysis charting.
        </span>
        <ProbePicker
          value={draft.probeKey}
          onChange={(key) => update("probeKey", key)}
        />
        {/* PR #205 (migration 0085): lot/batch number off the probe
            box, required by the health-inspection client procedure
            record. Optional; saved on this treatment area.
            PR #279 (migration 0095): can be auto-suggested from the
            sterile-item records and CONFIRMED for this treatment. A
            suggestion is never saved as confirmed until the practitioner
            taps Confirm; typing always works and un-confirms. */}
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Probe lot/batch number</span>
          <input
            type="text"
            value={draft.probeLotNumber}
            onChange={(e) =>
              // Editing the lot un-confirms it: a freshly typed value has not
              // been confirmed for this treatment yet.
              setDraft((d) => ({
                ...d,
                probeLotNumber: e.target.value,
                probeLotConfirmed: false,
              }))
            }
            placeholder="e.g. 460941"
            maxLength={120}
            className="max-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <span className="text-xs text-neutral-500">
            Used for health inspection and client procedure records.
          </span>
        </label>

        {/* PR #279: suggestion from records (only when there is one and the
            field is empty). Tapping "Use" fills the field but does NOT confirm. */}
        {suggestedProbeLot && draft.probeLotNumber.trim() === "" && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-neutral-500">
              Suggested from records:{" "}
              <span className="font-medium text-neutral-700 dark:text-neutral-300">
                {suggestedProbeLot}
              </span>
            </span>
            <button
              type="button"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  probeLotNumber: suggestedProbeLot,
                  probeLotConfirmed: false,
                }))
              }
              className="rounded-full border border-neutral-300 px-3 py-1 font-medium hover:border-neutral-500 dark:border-neutral-700"
            >
              Use this lot
            </button>
          </div>
        )}

        {/* PR #279: confirm control + state. Only meaningful once a lot is
            present; confirmation is explicit (never automatic). */}
        {draft.probeLotNumber.trim() !== "" && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              aria-pressed={draft.probeLotConfirmed}
              onClick={() =>
                update("probeLotConfirmed", !draft.probeLotConfirmed)
              }
              className={
                draft.probeLotConfirmed
                  ? "rounded-full bg-emerald-600 px-3 py-1 font-medium text-white"
                  : "rounded-full border border-neutral-300 px-3 py-1 font-medium hover:border-neutral-500 dark:border-neutral-700"
              }
            >
              {draft.probeLotConfirmed
                ? "Confirmed for this treatment ✓"
                : "Confirm lot for this treatment"}
            </button>
            {!draft.probeLotConfirmed && (
              <span className="text-neutral-500">
                Manually entered / not confirmed
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Mode</span>
        <div className="flex flex-wrap gap-2">
          {ELECTROLYSIS_MODES.map((m) => {
            const selected = draft.mode === m.value;
            return (
              <button
                key={m.value}
                type="button"
                onClick={() => update("mode", selected ? "" : m.value)}
                className={`rounded-full border px-4 py-2 text-sm transition ${
                  selected
                    ? "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900"
                    : "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }`}
              >
                {m.label}
              </button>
            );
          })}
        </div>
      </div>

      {showModality && (
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Modality</span>
          <select
            value={draft.apilusModality}
            onChange={(e) => {
              const next = e.target.value;
              setDraft((d) => ({
                ...d,
                apilusModality: next,
                // PR #279: OmniBlend has no thermolysis duration / galvanic
                // intensity. Clear any value typed under a different modality so
                // a NEW OmniBlend record can't persist a now-hidden reading.
                // (Editing an existing OmniBlend record seeds from the saved
                // entry and fires no onChange, so its history is preserved.)
                ...(next === "Omniblend"
                  ? { thermolysisDurationSeconds: "", galvanicIntensityPercent: "" }
                  : {}),
              }));
            }}
            className="max-w-sm rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          >
            <option value="">Select…</option>
            {modalityOptions.map((opt) => (
              <option key={opt} value={opt}>
                {apilusModalityLabel(opt)}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Treatment readings — the first pass, captured on this same page so
          there is no second form after saving. Mode-aware: thermolysis
          fields for thermolysis/blend, galvanic fields for galvanic/blend.
          All optional (pulse defaults to 1). Saved as the treatment area's
          first entry, keyed to the chosen area. */}
      <div className="flex flex-col gap-4 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <span className="text-sm font-medium">Treatment readings</span>

        {/* PR #279 (Chloe): energy level lives UNDER Treatment readings now (it
            used to sit near modality). Same energy_level column; UI move only. */}
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Energy level (EL)</span>
          <input
            type="number"
            inputMode="decimal"
            step="1"
            min={0}
            value={draft.energyLevel}
            onChange={(e) => update("energyLevel", e.target.value)}
            className="max-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        </label>

        {/* PR #279 (Chloe): OmniBlend charts galvanic BEFORE thermolysis; every
            other mode keeps thermolysis first. The section contents (incl.
            OmniBlend hiding thermolysis duration + galvanic intensity) are built
            above as thermoSection / galvSection. */}
        {isOmniblend ? (
          <>
            {galvSection}
            {thermoSection}
          </>
        ) : (
          <>
            {thermoSection}
            {galvSection}
          </>
        )}

        {/* Pulse count is a thermolysis concept — shown for thermolysis,
            blend, and when no mode is chosen yet; hidden for galvanic. */}
        {mode !== "galv" && (
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">Pulse count</span>
            <div className="flex items-stretch gap-2">
              <button
                type="button"
                onClick={() => bumpPulse(-1)}
                aria-label="Decrease pulse count"
                className="rounded-md border border-neutral-300 px-4 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                −
              </button>
              <input
                type="number"
                inputMode="numeric"
                min={PULSE_COUNT_MIN}
                max={PULSE_COUNT_MAX}
                value={draft.pulseCount}
                onChange={(e) => update("pulseCount", e.target.value)}
                className="w-20 rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
              />
              <button
                type="button"
                onClick={() => bumpPulse(1)}
                aria-label="Increase pulse count"
                className="rounded-md border border-neutral-300 px-4 text-lg font-medium hover:bg-neutral-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
              >
                +
              </button>
              <span className="self-center text-xs text-neutral-500">
                Pulses per hair (1 to {PULSE_COUNT_MAX}).
              </span>
            </div>
            {Number(draft.pulseCount) > 1 && (
              <div className="mt-2 flex flex-col gap-1.5">
                <span className="text-sm font-medium">Pulse delay</span>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min={PULSE_DELAY_MIN}
                    max={PULSE_DELAY_MAX}
                    value={draft.pulseDelay}
                    onChange={(e) => update("pulseDelay", e.target.value)}
                    aria-label="Pulse delay in seconds"
                    className="w-24 rounded-md border border-neutral-300 bg-white px-3 py-3 text-center text-base tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
                  />
                  <span className="text-sm text-neutral-500">seconds</span>
                </div>
                <span className="text-xs text-neutral-500">
                  Time between high-frequency pulses ({PULSE_DELAY_MIN} to{" "}
                  {PULSE_DELAY_MAX}s; default {PULSE_DELAY_DEFAULT}).
                </span>
              </div>
            )}
          </div>
        )}

        <label className="flex flex-col gap-1.5 md:max-w-[16rem]">
          <span className="text-sm font-medium">Hairs treated</span>
          <input
            type="number"
            inputMode="numeric"
            step="1"
            min={0}
            value={draft.hairsTreated}
            onChange={(e) => update("hairsTreated", e.target.value)}
            placeholder="500"
            className={READING_INPUT_CLS}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Minutes performed (optional)</span>
        <input
          type="number"
          inputMode="numeric"
          step="1"
          min={0}
          max={MINUTES_MAX}
          value={draft.minutes}
          onChange={(e) => update("minutes", e.target.value)}
          className="max-w-[16rem] rounded-md border border-neutral-300 bg-white px-3 py-2.5 text-sm tabular-nums outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
        <span className="text-xs text-neutral-500">
          Used for total treatment time if you track it.
        </span>
      </label>

      {/* PR #279 (migration 0095): numbing record — a factual note of whether
          the client used numbing before treatment. "Not recorded" (NULL) is the
          default. No advice / dosing / product guidance. */}
      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <span className="text-sm font-medium">Numbing</span>
        <div className="flex flex-wrap gap-2">
          {NUMBING_OPTIONS.map((opt) => {
            const selected = draft.numbingStatus === opt.value;
            return (
              <button
                key={opt.value || "not-recorded"}
                type="button"
                aria-pressed={selected}
                onClick={() => update("numbingStatus", opt.value)}
                className={
                  selected
                    ? "rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
                    : "rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Client tolerance (PR #279): label-based comfort scale. The CONTROL is
          labels (the raw 1-5 was not intuitive), but the stored value is still
          the 1-5 smallint tolerance_rating, so every existing record maps
          cleanly. Factual comfort descriptions, no medical judgment. */}
      <div className="flex flex-col gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <div>
          <span className="text-sm font-medium">Client tolerance</span>
          <p className="text-xs text-neutral-500">
            Optional. How did the client tolerate this area?
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {TOLERANCE_OPTIONS.map((opt) => {
            const value = String(opt.value);
            const selected = draft.toleranceRating === value;
            return (
              <button
                key={opt.value}
                type="button"
                aria-pressed={selected}
                onClick={() =>
                  update("toleranceRating", selected ? "" : value)
                }
                className={
                  selected
                    ? "rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white dark:bg-white dark:text-neutral-900"
                    : "rounded-full border border-neutral-300 bg-white px-4 py-2 text-sm text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Treatment observations (PR #191 bucket A): what the
          practitioner SAW during treatment: follicle/skin/hair
          characteristics. Quick-tap chips + free text, same controls
          as the add-another-pass form. Distinct from the client/skin
          response bucket below (how the client reacted) and the
          for-next-visit bucket (what to do differently). */}
      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <div>
          <span className="text-sm font-medium">Treatment observations</span>
          <p className="text-xs text-neutral-500">
            What you saw during treatment, including how the skin and client responded.
          </p>
        </div>
        {/* PR #279 (Chloe mobile feedback): observation chips are TOGGLES — tap
            to add the phrase to the notes, tap again to remove it. Selected
            chips show pressed and their text appears in the notes box below;
            manually typed text is preserved. (Was append-only, which could not
            be unselected.) */}
        <div className="flex flex-wrap gap-2">
          {COMMON_COMMENTS.map((c) => {
            const selected = isCommentSelected(draft.comments, c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={selected}
                onClick={() => update("comments", toggleComment(draft.comments, c))}
                className={
                  selected
                    ? "rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
                    : "rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300 dark:hover:bg-neutral-900"
                }
              >
                {selected ? c : `+ ${c}`}
              </button>
            );
          })}
        </div>
        {/* PR #198/#279: skin/client response options as chips. Single-select
            toggle on the reaction_type field — tap again to clear, and picking
            one (e.g. "No visible reaction") replaces any other (deliberate
            conflict handling). The choice is saved as the block's reaction and
            shows in the saved record. */}
        <div className="flex flex-wrap gap-2">
          {REACTION_TYPES.map((r) => (
            <button
              key={r}
              type="button"
              aria-pressed={draft.reactionType === r}
              onClick={() =>
                update("reactionType", draft.reactionType === r ? "" : r)
              }
              className={
                draft.reactionType === r
                  ? "rounded-full bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white dark:bg-white dark:text-neutral-900"
                  : "rounded-full border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300"
              }
            >
              {/* PR #203: leading + so these read as the same kind of
                  addable observation chip as the row above. */}
              + {reactionTypeLabel(r)}
            </button>
          ))}
        </div>
        {/* PR #197: ONE free-text box per area (Treatment
            observations). This response-notes textarea only renders
            when a saved note already exists, so legacy data stays
            visible and editable without asking for the same note
            twice. */}
        {draft.reactionNotes.trim() !== "" && (
          <textarea
            rows={2}
            value={draft.reactionNotes}
            onChange={(e) => update("reactionNotes", e.target.value)}
            className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        )}
        <textarea
          rows={2}
          value={draft.comments}
          onChange={(e) => update("comments", e.target.value)}
          placeholder="Tap a chip or type a note"
          className="rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
        />
      </div>

      {/* PR #199 (Chloe iPad retest): the per-area next-visit and
          caution inputs are gone. The session-level note on the
          session page is the ONE place to write next-visit
          instructions (it can name specific areas). The draft still
          carries any previously saved caution flag/note and the save
          payload still round-trips them, so old area-level caution
          data is never lost and keeps rendering in the From last
          visit summaries. */}

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <button
          type="button"
          onClick={submit}
          disabled={pending}
          className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : "Save treatment area"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-neutral-300 px-5 py-3 text-sm hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-900"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// Cascading probe picker (Session Logging Phase B). Brand → material →
// valid option chips. Only combinations present in the lib/probes.ts
// catalog are ever offered, so impossible probes can't be selected. The
// value is a single catalog key (or "" for none); the server re-validates
// it. Probe is optional — leaving it blank is fine.
const CHIP_BASE =
  "rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-50";
const CHIP_OFF =
  "border-neutral-300 bg-white text-neutral-700 hover:border-neutral-500 dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-300";
const CHIP_ON =
  "border-neutral-900 bg-neutral-900 text-white dark:border-white dark:bg-white dark:text-neutral-900";

function ProbePicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (key: string) => void;
}) {
  const selected = findProbeOptionByKey(value);

  // Drill-down state. Seeded from the selected option so "Change" reopens
  // on the right brand/material. Editing is true while the practitioner is
  // actively choosing (no selection yet, or they tapped "Change").
  const [editing, setEditing] = useState(!selected);
  const [brand, setBrand] = useState<ProbeBrand | "">(selected?.brand ?? "");
  const [material, setMaterial] = useState<ProbeMaterial | "">(
    selected?.material ?? "",
  );

  // Collapsed summary once a probe is chosen.
  if (selected && !editing) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-md border border-neutral-300 bg-neutral-50 px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900">
          {selected.displayLabel}
        </span>
        <button
          type="button"
          onClick={() => {
            setBrand(selected.brand);
            setMaterial(selected.material);
            setEditing(true);
          }}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Change
        </button>
        <button
          type="button"
          onClick={() => {
            onChange("");
            setBrand("");
            setMaterial("");
            setEditing(true);
          }}
          className="text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Clear
        </button>
      </div>
    );
  }

  const materials = brand ? getMaterialsForBrand(brand) : [];
  const options = brand && material ? getProbeOptionsFor(brand, material) : [];

  return (
    <div className="flex flex-col gap-3 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      {/* Brand */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
          Brand
        </span>
        <div className="flex flex-wrap gap-1.5">
          {PROBE_BRANDS.map((b) => (
            <button
              key={b}
              type="button"
              aria-pressed={brand === b}
              onClick={() => {
                setBrand(b);
                setMaterial("");
              }}
              className={`${CHIP_BASE} ${brand === b ? CHIP_ON : CHIP_OFF}`}
            >
              {b}
            </button>
          ))}
        </div>
      </div>

      {/* Material / type family */}
      {brand && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Material
          </span>
          <div className="flex flex-wrap gap-1.5">
            {materials.map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={material === m}
                onClick={() => setMaterial(m)}
                className={`${CHIP_BASE} ${material === m ? CHIP_ON : CHIP_OFF}`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Valid options */}
      {brand && material && (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            Probe
          </span>
          <div className="flex flex-wrap gap-1.5">
            {options.map((o) => (
              <button
                key={o.key}
                type="button"
                aria-pressed={value === o.key}
                onClick={() => {
                  onChange(o.key);
                  setEditing(false);
                }}
                className={`${CHIP_BASE} ${value === o.key ? CHIP_ON : CHIP_OFF}`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {selected && (
        <button
          type="button"
          onClick={() => setEditing(false)}
          className="self-start text-xs text-neutral-500 underline hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          Done
        </button>
      )}
    </div>
  );
}
