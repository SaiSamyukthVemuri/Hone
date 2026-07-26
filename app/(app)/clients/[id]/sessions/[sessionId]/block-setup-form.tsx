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

import { useEffect, useId, useMemo, useRef, useState, useTransition } from "react";
import {
  APILUS_MODALITIES_BY_MODE,
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
import type { ProbeLotSuggestions } from "@/lib/record-keeping/probe-lot-suggestion";
import { ProbeLotSelect } from "@/components/probe-lot-select";
import {
  resolveInventoryAutofill,
  probeLotOptionsForProbe,
  type ProbeLotOption,
} from "@/lib/record-keeping/probe-lot-inventory";
import type { SessionBlockWithEntries } from "@/lib/supabase/queries";
import {
  buildTreatmentSetupDraftPatch,
  firstLiveEntry,
} from "@/lib/sessions/treatment-setup-snapshot";
import type {
  ApilusModality,
  ElectrolysisEntry,
  ElectrolysisMode,
  MachineFrequency,
  SessionBlock,
  SessionBlockSide,
  SessionMode,
} from "@/lib/types/database";
import {
  isChipSelected,
  toggleFindingChip,
  resolveDisplayChips,
  mergeReactionIntoChips,
  MERGED_OBSERVATION_CHIPS,
} from "@/lib/observation-chips";
import { SelectedObservations } from "@/components/selected-observations";
import {
  NUMBING_OPTIONS,
  TOLERANCE_OPTIONS,
  isReactionType,
  reactionTypeLabel,
  type ReactionType,
} from "@/lib/sessions/clinical-response";
import {
  OBSERVATIONS_RESPONSE_HEADING,
  OBSERVATIONS_RESPONSE_HELPER,
  ADDITIONAL_NOTES_HEADING,
  ADDITIONAL_NOTES_HELPER,
} from "@/lib/sessions/charting-labels";
import { SESSION_BLOCK_SIDE_OPTIONS } from "@/lib/sessions/side-labels";
import { AreaPicker } from "@/components/area-picker";
import { isCanonicalTreatmentArea } from "@/lib/sessions/area-validation";
import { BodyMapAreaPicker } from "@/components/body-map-area-picker";
import { MultiAreaEditor } from "@/components/multi-area-editor";
import { resolveBlockAreas, type BlockArea } from "@/lib/sessions/block-areas";
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
  previousBlock: SessionBlockWithEntries | null;
  // PR #191: every saved treatment area in this session, in sort
  // order. Copy settings prefers the most recent area matching the
  // currently selected treatment area before falling back to the
  // last one.
  savedBlocks?: SessionBlockWithEntries[];
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
  // Feature A (reliability): most recent lot/batch per probe in this studio,
  // keyed by probe_key AND by normalized probe_label (free-text fallback), each
  // carrying its confirmed flag. The form auto-populates the lot field for the
  // selected probe (studio-scoped, never auto-confirmed) — keyed match first,
  // label fallback second. Empty when there is nothing to suggest.
  probeLotSuggestions?: ProbeLotSuggestions;
  // Migration 0128 charting release: the studio's ACTIVE probe-lot inventory
  // (record_keeping_sterile_items probe rows) powering the searchable selector.
  // Manual entry always stays available; expired lots are still selectable but
  // flagged. Empty = the selector shows the "No active probe lots found" state.
  probeLotInventory?: ProbeLotOption[];
  // Migration 0128: the block's structured areas on edit (empty for legacy /
  // create). Seeds the multi-area editor; the read path falls back to
  // primary_area + side when empty.
  initialAreas?: BlockArea[];
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
  // Treatment area (0039, legacy). Retained for copy/back-compat but the UI now
  // drives the structured `areas` set (migration 0128) below.
  primaryArea: string;
  side: string; // SessionBlockSide | ""
  customAreaDetail: string;
  // Multi-area (0128): the areas treated with these settings, each with its own
  // laterality. This is the authoritative area input the form submits.
  areas: BlockArea[];
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
  // Migration 0108: structured observation chips (canonical labels). Selection
  // is explicit state here, NOT re-derived from `comments`, so a selected chip
  // can never silently disappear. Free-text lives in `comments` above.
  observationChips: string[];
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
  // 0156: optional free-text numbing note. Held in draft even while the status
  // is toggled away from "used" (so toggling back restores it); the server
  // stores it only when the saved status is "used".
  numbingNotes: string;
  probeLotConfirmed: boolean;
  // Migration 0155: the linked sterile-inventory item id when the lot was chosen
  // from inventory; null = manual/unlinked. The saved probe_lot_number is still
  // the authoritative snapshot.
  probeInventoryItemId: string | null;
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
  areas: [],
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
  observationChips: [],
  toleranceRating: "",
  reactionType: "",
  reactionNotes: "",
  cautionForNextSession: false,
  cautionNote: "",
  numbingStatus: "",
  numbingNotes: "",
  probeLotConfirmed: false,
  probeInventoryItemId: null,
};

function initialDraft(
  block: SessionBlock | null | undefined,
  firstEntry: ElectrolysisEntry | null | undefined,
  defaultPrimaryArea: string | null | undefined,
  defaultMachineFrequency?: string | null,
  initialAreas?: BlockArea[],
): Draft {
  // Create mode: start blank, but seed the treatment area from the attached
  // plan when provided, and the machine frequency from the practitioner's
  // sticky last-used default (PR #203, migration 0084). Both editable;
  // never forced.
  if (!block) {
    const seed = defaultPrimaryArea?.trim() || "";
    return {
      ...EMPTY,
      primaryArea: seed,
      areas: seed ? [{ area: seed, laterality: "not_applicable" }] : [],
      machineFrequency: defaultMachineFrequency?.trim() || "",
    };
  }
  // Migration 0108: seed structured observation chips. New rows carry
  // observation_chips directly; legacy rows (empty chips) are hydrated from
  // `comments` NON-destructively — matched chip tokens become chips, everything
  // else stays as free-text — so editing an old record shows chips reliably and
  // never double-displays them. The stored row is untouched until the
  // practitioner saves.
  // Chip-loading fix: seed the SAME way the entry-row renders — via the single
  // resolveDisplayChips contract. Structured chips preload directly; a LEGACY
  // entry (empty observation_chips) hydrates its chips out of `comments` so
  // reopening an old treatment area shows them as SELECTED controls, with the
  // remaining free-text as the note. Stored data is untouched until save.
  const hydrated = (() => {
    const r = resolveDisplayChips(firstEntry?.observation_chips, firstEntry?.comments);
    return { chips: r.chips, freeText: r.note };
  })();
  return {
    mode: block.mode ?? "",
    apilusModality: block.apilus_modality ?? "",
    energyLevel: block.energy_level != null ? String(block.energy_level) : "",
    probeKey: block.probe_key ?? "",
    probeLotNumber: block.probe_lot_number ?? "",
    machineFrequency: block.machine_frequency ?? "",
    minutes:
      block.minutes_performed != null ? String(block.minutes_performed) : "",
    // Multi-area (0128): structured child rows take precedence; a legacy block
    // (no child rows) falls back to primary_area + side as a single area.
    areas: resolveBlockAreas(initialAreas ?? [], {
      primary_area: block.primary_area,
      side: block.side,
    }),
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
    comments: hydrated.freeText,
    // Charting unification: fold a legacy reaction_type into the ONE merged chip
    // selection (shown as a selected chip). On save it migrates into
    // observation_chips and reaction_type is cleared — the value is preserved,
    // never a separate row.
    observationChips: mergeReactionIntoChips(hydrated.chips, block.reaction_type),
    // PR #190: round-trip the stored response so an edit save that
    // never touches the section preserves it unchanged.
    toleranceRating:
      block.tolerance_rating != null ? String(block.tolerance_rating) : "",
    // Keep the ORIGINAL legacy reaction_type so save can preserve it while its
    // equivalent chip stays selected, and clear it ONLY if the practitioner
    // deselects that reaction. Its label is folded into observationChips above
    // for display. Never edited directly.
    reactionType: block.reaction_type ?? "",
    reactionNotes: block.reaction_notes ?? "",
    cautionForNextSession: block.caution_for_next_session ?? false,
    cautionNote: block.caution_note ?? "",
    // PR #279 (migration 0095): round-trip numbing + lot confirmation.
    numbingStatus: block.numbing_status ?? "",
    numbingNotes: block.numbing_notes ?? "",
    probeLotConfirmed: block.probe_lot_confirmed ?? false,
    probeInventoryItemId: block.probe_inventory_item_id ?? null,
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
  probeLotSuggestions = { byKey: {}, byLabel: {} },
  probeLotInventory = [],
  initialAreas,
  onCancel,
}: Props) {
  const isEdit = !!block;
  const [draft, setDraft] = useState<Draft>(() =>
    initialDraft(block, firstEntry, defaultPrimaryArea, defaultMachineFrequency, initialAreas),
  );
  // Feature A: whether the practitioner has typed/edited the lot themselves. A
  // saved lot on an existing block counts as manual (never clobber it). While
  // false, the lot field auto-populates from the same-probe suggestion as the
  // practitioner picks a probe; once they edit, we stop suggesting so a probe
  // switch never overwrites a manual value.
  // Only a MANUAL saved lot (probe_lot_number present AND no inventory link)
  // counts as "manually edited" — a linked block is inventory-backed, not
  // manual, so a probe switch re-runs the inventory auto-fill for it.
  const [lotEditedManually, setLotEditedManually] = useState<boolean>(
    () =>
      (block?.probe_lot_number ?? "").trim() !== "" &&
      (block?.probe_inventory_item_id ?? null) == null,
  );
  const [error, setError] = useState<string | null>(null);
  // PR #191: inline feedback after "Copy settings" so the
  // practitioner knows what was copied and from where.
  const [copyMessage, setCopyMessage] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // 0156: stable id so the numbing-notes helper text is programmatically
  // connected to the textarea via aria-describedby.
  const numbingNotesHelpId = useId();
  // Treatment-area picker is collapsed to a compact summary when an area is
  // already selected (e.g. seeded from the plan, or in edit mode); the full
  // region-grouped picker only expands when there's no area yet or the
  // practitioner taps "Change".

  // Inventory-backed lot auto-fill (migration 0155). Runs ONLY when the
  // practitioner CHANGES the probe (never on mount, so an edited block keeps its
  // saved selection), and never over a manual entry. It considers ONLY ACTIVE
  // inventory for the new probe_key; auto-fills the last-confirmed linked lot,
  // else the sole active lot, else clears to the chooser. Auto-filled lots are
  // always UNCONFIRMED. A linked lot for the OLD probe is cleared here.
  const autofilledForProbeRef = useRef<string>(draft.probeKey);
  const [lotStatus, setLotStatus] = useState<
    "last-confirmed" | "only-active" | "choose" | "manual" | null
  >(() =>
    (block?.probe_lot_number ?? "").trim() !== "" &&
    (block?.probe_inventory_item_id ?? null) == null
      ? "manual"
      : null,
  );

  // Options (active + expired) for the currently selected probe.
  const probeOptions = useMemo(
    () => probeLotOptionsForProbe(probeLotInventory, draft.probeKey),
    [probeLotInventory, draft.probeKey],
  );

  useEffect(() => {
    if (draft.probeKey === autofilledForProbeRef.current) return; // no probe change
    autofilledForProbeRef.current = draft.probeKey;
    if (lotEditedManually) return; // a genuine manual lot survives a probe switch
    // Auto-fill is driven ONLY by the newest prior selection that was BOTH
    // confirmed AND inventory-linked (lastConfirmedInventoryItemId) — a newer
    // confirmed MANUAL row can never mask it, and an unconfirmed linked row never
    // qualifies. resolveInventoryAutofill still requires that id to be active +
    // matching the selected probe (contract #2 unambiguous rule).
    const lastConfirmedId =
      probeLotSuggestions.byKey[draft.probeKey]?.lastConfirmedInventoryItemId ??
      null;
    const autofill = resolveInventoryAutofill(
      probeLotInventory,
      draft.probeKey,
      lastConfirmedId,
    );
    setLotStatus(autofill.kind);
    setDraft((d) =>
      autofill.kind === "choose"
        ? {
            ...d,
            probeInventoryItemId: null,
            probeLotNumber: "",
            probeLotConfirmed: false,
          }
        : {
            ...d,
            probeInventoryItemId: autofill.option.id,
            probeLotNumber: autofill.option.lotNumber,
            probeLotConfirmed: false,
          },
    );
    // React to the PROBE changing, not our own writes (setDraft is stable).
  }, [draft.probeKey, lotEditedManually, probeLotInventory, probeLotSuggestions]);

  const lotSourceMessage =
    lotStatus === "last-confirmed"
      ? "Auto-filled from your last confirmed inventory lot. Confirm the package."
      : lotStatus === "only-active"
        ? "Only active inventory lot for this probe. Confirm the package."
        : lotStatus === "choose"
          ? "Choose the lot/batch from inventory."
          : null;

  function update<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  // PR #270: single area-change handler shared by the body map and the
  // list-below AreaPicker, so both write the same primary_area and clearing
  // the area also clears side + specifics (no orphan side).

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
    // Full reusable setup via the shared snapshot contract: block machine
    // settings PLUS the primary (earliest live) entry's mode-gated machine
    // readings (thermolysis/galvanic/units-of-lye/pulse). Destination areas, a
    // manually entered probe lot, and every outcome/response field are
    // preserved — the patch carries ONLY reusable setup keys.
    const firstEntry = firstLiveEntry(source.electrolysis_entries);
    const patch = buildTreatmentSetupDraftPatch(source, firstEntry);
    setDraft((d) => ({ ...d, ...patch }));
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
    // PR 2: explicit custom-area intent. A non-empty area that isn't canonical
    // can only come from the picker's "Other" free-text path, so flag it so the
    // server accepts it as a deliberate custom area (not a typo/garbage).
    const areaIsCustom =
      trimmedArea.length > 0 && !isCanonicalTreatmentArea(trimmedArea);
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
      // Charting unification: the reaction is captured in the merged
      // observation_chips selection. PRESERVE a historical reaction_type while
      // its equivalent chip is still selected (so an unrelated edit never erases
      // it); clear it ONLY when the practitioner explicitly deselects that
      // reaction. Never invent/collapse a reaction_type from chips — a new
      // record keeps reaction_type NULL and lives entirely in observation_chips.
      reactionType:
        draft.reactionType &&
        isReactionType(draft.reactionType) &&
        isChipSelected(
          draft.observationChips,
          reactionTypeLabel(draft.reactionType as ReactionType),
        )
          ? draft.reactionType
          : null,
      reactionNotes: draft.reactionNotes.trim() || null,
      cautionForNextSession: draft.cautionForNextSession,
      cautionNote: draft.cautionNote.trim() || null,
      // PR #279: numbing record ("" -> Not recorded -> null in the action).
      numbingStatus: draft.numbingStatus || null,
      // 0156: optional numbing note. Always sent; the server keeps it only when
      // the saved status is "used" (else stores NULL). Held in draft across
      // status toggles so a mistaken toggle doesn't lose typed text.
      numbingNotes: draft.numbingNotes,
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
      observationChips: draft.observationChips,
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
          // Optimistic concurrency: the version this form loaded (0129).
          expectedUpdatedAt: block.updated_at,
          mode: (draft.mode || null) as SessionMode | null,
          apilusModality: (draft.apilusModality || null) as
            | ApilusModality
            | null,
          energyLevel: elNum,
          minutesPerformed: minutesNum,
          probeOptionKey: draft.probeKey || null,
          probeLotNumber: draft.probeLotNumber.trim() || null,
          probeLotConfirmed: draft.probeLotConfirmed,
          probeInventoryItemId: draft.probeInventoryItemId,
          machineFrequency: (draft.machineFrequency || null) as
            | MachineFrequency
            | null,
          primaryArea: trimmedArea || null,
          side: draft.side || null,
          customAreaDetail: trimmedDetail || null,
          areaIsCustom,
          // Multi-area (0128): authoritative when non-empty; the action derives
          // the legacy primary_area/side projection from it.
          areas: draft.areas,
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
          probeInventoryItemId: draft.probeInventoryItemId,
        machineFrequency: (draft.machineFrequency || null) as
          | MachineFrequency
          | null,
        primaryArea: trimmedArea || null,
        side: draft.side || null,
        customAreaDetail: trimmedDetail || null,
        areaIsCustom,
        // Multi-area (0128): authoritative when non-empty.
        areas: draft.areas,
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
        {/* Pulse count is a THERMOLYSIS concept (Chloe): it lives inside the
            thermolysis section and is labeled "Thermolysis pulse count". Shown
            for thermolysis + blend (this section); pure galvanic has none. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium">Thermolysis pulse count</span>
          <div className="flex items-stretch gap-2">
            <button
              type="button"
              onClick={() => bumpPulse(-1)}
              aria-label="Decrease thermolysis pulse count"
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
              aria-label="Increase thermolysis pulse count"
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
          {/* Galvanic intensity % is removed as an ACTIVE input (Chloe / PicoBlend
              feedback). Historical values are preserved: draft.galvanicIntensityPercent
              is still hydrated from the stored entry and round-tripped on save, so
              editing a legacy galvanic entry never wipes its recorded intensity;
              new entries simply leave it blank (NULL). No migration. */}
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
          {isEdit ? "Edit settings block" : "Add settings block"}
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

      {/* Multi-area (0128): areas treated with these settings, each with its
          own laterality. Replaces the single-area picker; the server persists
          canonical session_block_areas rows + a legacy primary_area/side. */}
      <MultiAreaEditor
        value={draft.areas}
        onChange={(areas) => update("areas", areas)}
        idPrefix={`area-${block?.id ?? "new"}-${sessionId}`}
      />

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
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium">Probe lot/batch number</span>
          {/* Migration 0128 charting release: searchable ACTIVE probe-lot
              selector backed by the studio's sterile-item inventory. Manual
              entry always works (typing sets the value and is never replaced);
              selecting a lot fills the field. The SAVED value is still the
              free-text lot-number snapshot on session_blocks.probe_lot_number —
              no FK, so archiving/expiring a lot never rewrites past charting. */}
          <ProbeLotSelect
            value={draft.probeLotNumber}
            selectedInventoryItemId={draft.probeInventoryItemId}
            options={probeOptions}
            inventoryHref="/records?section=sterile"
            onSelectInventory={(option) => {
              // An explicit inventory selection: store the durable id + the
              // option's visible lot number, reset confirmation, NOT manual.
              setDraft((d) => ({
                ...d,
                probeInventoryItemId: option.id,
                probeLotNumber: option.lotNumber,
                probeLotConfirmed: false,
              }));
              setLotEditedManually(false);
              setLotStatus(null);
            }}
            onManualChange={(value) => {
              // Typing clears any inventory link, un-confirms, and marks manual
              // so a later probe switch never clobbers it. Clearing it back to
              // empty re-enables inventory auto-fill for the next probe.
              setDraft((d) => ({
                ...d,
                probeInventoryItemId: null,
                probeLotNumber: value,
                probeLotConfirmed: false,
              }));
              setLotEditedManually(value.trim() !== "");
              setLotStatus(value.trim() !== "" ? "manual" : "choose");
            }}
          />
          {lotSourceMessage && (
            <span
              data-testid="probe-lot-source"
              className="text-xs text-neutral-600 dark:text-neutral-400"
            >
              {lotSourceMessage}
            </span>
          )}
          <span className="text-xs text-neutral-500">
            Used for health inspection and client procedure records.
          </span>
        </div>

        {/* Migration 0155: the inventory-backed lot source/status message
            (last-confirmed auto-fill / only-active / choose) is rendered
            immediately under the selector above; manual/linked state shows as a
            badge in the selector. */}

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
                ? "Confirmed ✓"
                : "Confirm lot/batch"}
            </button>
            {!draft.probeLotConfirmed && lotEditedManually && (
              <span className="text-neutral-500">
                Lot/batch changed for this entry.
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
        {/* 0156: ONE optional free-text note, revealed ONLY when numbing was
            used. Factual — no dosing/timing/medical instructions. The draft
            value is retained across status toggles (so toggling back to "used"
            restores it); the server discards it unless the saved status is
            "used". Label wraps the textarea (accessible name) and the helper is
            connected via aria-describedby; full-width so it never overflows at
            390px; vertically resizable. */}
        {draft.numbingStatus === "used" && (
          <label className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
              Numbing notes (optional)
            </span>
            <textarea
              rows={3}
              value={draft.numbingNotes}
              onChange={(e) => update("numbingNotes", e.target.value)}
              data-testid="numbing-notes"
              aria-describedby={numbingNotesHelpId}
              placeholder="Record the product or any relevant details"
              className="w-full min-h-[5rem] resize-y rounded-md border border-neutral-300 bg-white px-3 py-3 text-base leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
            />
            <span id={numbingNotesHelpId} className="text-xs text-neutral-500">
              Record the product or any relevant details.
            </span>
          </label>
        )}
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

      {/* UNIFIED (Chloe): "Treatment observations & skin response" is ONE box —
          a single MERGED multi-select chip list (observation presets + the former
          reaction labels). Everything is stored in observation_chips (the
          canonical multi column). A legacy session_blocks.reaction_type is folded
          into this selection on load (shown as a selected chip) and migrated into
          observation_chips on save — the value is preserved, never a separate
          single-select row. Multiple findings may be selected together. */}
      <div className="flex flex-col gap-2 border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <div>
          <span className="text-sm font-medium">
            {OBSERVATIONS_RESPONSE_HEADING}
          </span>
          <p className="text-xs text-neutral-500">
            {OBSERVATIONS_RESPONSE_HELPER}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {MERGED_OBSERVATION_CHIPS.map((c) => {
            const selected = isChipSelected(draft.observationChips, c);
            return (
              <button
                key={c}
                type="button"
                data-testid={`obs-chip-${c}`}
                aria-pressed={selected}
                onClick={() =>
                  update("observationChips", toggleFindingChip(draft.observationChips, c))
                }
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
        {/* Chip confidence (Chloe): show exactly which findings are selected and
            will be saved, adjacent to the chips, so a tap visibly "takes". */}
        <SelectedObservations chips={draft.observationChips} />
        {/* Legacy per-area response note (reaction_notes): preserved + editable
            only when one already exists, so old data is never lost. */}
        {draft.reactionNotes.trim() !== "" && (
          <textarea
            rows={2}
            value={draft.reactionNotes}
            onChange={(e) => update("reactionNotes", e.target.value)}
            aria-label="Legacy response note"
            className="w-full resize-y rounded-md border border-neutral-300 bg-white px-3 py-3 text-base outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
        )}
        {/* Additional notes — one large free-text box directly beneath the merged
            chip list. ~8 rows, >=12rem, full-width + vertically resizable, safe at
            390px; multiline preserved verbatim. */}
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium uppercase tracking-wider text-neutral-500">
            {ADDITIONAL_NOTES_HEADING}
          </span>
          <textarea
            rows={8}
            value={draft.comments}
            onChange={(e) => update("comments", e.target.value)}
            data-testid="additional-notes"
            placeholder="Add any details not covered by the findings above"
            className="w-full min-h-[12rem] resize-y rounded-md border border-neutral-300 bg-white px-3 py-3 text-base leading-relaxed outline-none focus:border-neutral-900 dark:border-neutral-700 dark:bg-neutral-950"
          />
          <span className="text-xs text-neutral-500">
            {ADDITIONAL_NOTES_HELPER}
          </span>
        </label>
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
          data-testid="save-treatment-area"
          className="rounded-md bg-neutral-900 px-5 py-3 text-sm font-medium text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {pending ? "Saving…" : "Save settings block"}
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
