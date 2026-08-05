// POINT-OF-CARE TREATMENT MEMORY — the "Last treatment" view model rendered on
// the live charting screen.
//
// WHY THIS EXISTS
// ---------------
// buildLastSessionSummary (lib/sessions/clinical-summary.ts) is the compact
// PRE-treatment recap: area, settings, probe label, tolerance, response. It is
// deliberately small, and four surfaces depend on its exact shape.
//
// While Chloe is actually treating, she needs the setup she is about to
// reproduce, which that summary does not carry: the machine frequency, the
// probe LOT she must match, whether numbing was used, how many hairs came out,
// and the mode-valid machine readings. This module builds that fuller memory
// WITHOUT forking the display vocabulary — every label comes from the existing
// shared helpers:
//
//   area + laterality      lib/sessions/block-areas.ts   (resolveBlockAreas / formatAreaLabel)
//   mode-valid readings    lib/sessions/reading-field-order.ts (readingFieldOrder)
//   thermolysis seconds    lib/sessions/format-seconds.ts (3dp — 0.733 stays 0.733)
//   tolerance              lib/sessions/clinical-response.ts (toleranceLabel)
//   numbing                lib/sessions/clinical-response.ts (numbingDisplay)
//   unified response       lib/sessions/reaction-unified.ts (unifiedReactionLabels)
//   canonical pass         lib/sessions/treatment-setup-snapshot.ts (firstLiveEntry)
//
// RULES THIS MODULE ENFORCES
//   * MODE GATING. This is the first READ surface in the repository to apply
//     it. A block charted as thermolysis never shows stale galvanic readings
//     left over from an earlier mode, because the field list comes from
//     readingFieldOrder(mode) rather than from "which columns happen to be
//     non-null" (which is what components/entry-row.tsx does).
//   * RETIRED INPUT. galvanic_intensity_percent is never read, never displayed.
//   * NO SILENT PASS PICKING. Block-level setup comes from the block row.
//     Entry-level setup comes from the CANONICAL pass (firstLiveEntry — the
//     earliest live entry, the same rule the in-form Copy settings control
//     uses). Hairs are SUMMED across every live pass, which is how the product
//     already totals them (lib/sessions/treatment-intelligence.ts). Pass count
//     is surfaced whenever there is more than one, so an aggregate is never
//     mistaken for a single reading.
//   * SOFT-DELETED PASSES ARE EXCLUDED everywhere — from the canonical pass,
//     from the hair total, from the pass count and from the response chips.
//   * NO TRUNCATION OF CLINICAL TEXT. buildLastSessionSummary drops a
//     reaction note longer than 140 characters; here the note is a separate
//     field so the card can wrap it instead of losing it.
//
// Pure. No I/O. Client-safe.

import {
  formatAreaLabel,
  resolveBlockAreas,
  type BlockArea,
} from "@/lib/sessions/block-areas";
import { apilusModalityLabel } from "@/lib/constants";
import { formatSeconds } from "@/lib/sessions/format-seconds";
import {
  READING_FIELD_LABELS,
  readingFieldOrder,
  type ReadingField,
} from "@/lib/sessions/reading-field-order";
import { numbingDisplay, toleranceLabel } from "@/lib/sessions/clinical-response";
import { unifiedReactionLabels } from "@/lib/sessions/reaction-unified";
import {
  firstLiveEntry,
  type SetupSourceEntry,
} from "@/lib/sessions/treatment-setup-snapshot";
import type { ClinicalSummaryBlock } from "@/lib/sessions/clinical-summary";
import type { SessionBlockSide } from "@/lib/types/database";

// Practitioner-facing mode names. Mirrors clinical-summary.ts's MODE_LABELS so
// the two memory surfaces read identically.
const MODE_LABELS: Record<string, string> = {
  thermo: "Thermolysis",
  blend: "Blend",
  galv: "Galvanic",
};

// PostgREST delivers `numeric` columns as strings often enough that every
// numeric read here is coerced before formatting (components/entry-row.tsx:132
// does the same for pulse delay). A non-finite value reads as absent, never as 0.
function num(value: number | string | null | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function trimmedOrNull(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

// The machine readings, as they are stored on an electrolysis entry. Every
// numeric accepts a string so a raw PostgREST row satisfies the type.
// galvanic_intensity_percent is DELIBERATELY absent: a retired input is never
// read (see lib/sessions/treatment-setup-snapshot.ts ENTRY_SETUP_FIELDS).
export type PointOfCareEntry = {
  id?: string;
  created_at: string;
  deleted_at: string | null;
  mode: string | null;
  hairs_treated?: number | string | null;
  observation_chips?: unknown;
  thermolysis_intensity_percent?: number | string | null;
  thermolysis_duration_seconds?: number | string | null;
  galvanic_ma?: number | string | null;
  galvanic_duration_seconds?: number | string | null;
  units_of_lye?: number | string | null;
  pulse_count?: number | string | null;
  pulse_delay_seconds?: number | string | null;
};

export type PointOfCareBlock = {
  id: string;
  sort_order?: number | null;
  block_name?: string | null;
  primary_area?: string | null;
  side?: SessionBlockSide | string | null;
  mode?: string | null;
  apilus_modality?: string | null;
  energy_level?: number | string | null;
  minutes_performed?: number | string | null;
  machine_frequency?: string | null;
  probe_label?: string | null;
  probe_type?: string | null;
  probe_size?: string | null;
  probe_lot_number?: string | null;
  probe_lot_confirmed?: boolean | null;
  numbing_status?: string | null;
  numbing_notes?: string | null;
  tolerance_rating?: number | null;
  reaction_type?: string | null;
  reaction_notes?: string | null;
  caution_for_next_session?: boolean | null;
  caution_note?: string | null;
  // Migration 0128 structured areas. When present they are authoritative.
  structured_areas?: ReadonlyArray<BlockArea> | null;
  // Every entry belonging to this block, live or soft-deleted. Filtering
  // happens HERE so a caller cannot forget it.
  entries?: ReadonlyArray<PointOfCareEntry> | null;
};

// A dated clinical note reduced to what a point-of-care card may show: never
// the whole body by default.
export type PointOfCareNote = {
  occurredAt: string;
  excerpt: string;
  truncated: boolean;
  authorName: string | null;
  total: number;
};

export type PointOfCareReading = {
  field: ReadingField;
  // "Thermolysis duration (s)" — the capture-form label, so the card can be
  // read against the machine.
  label: string;
  // Self-describing display value: "0.733 seconds", "3 UL", "40%", "2 pulses".
  value: string;
};

export type PointOfCareArea = {
  // The block id — a stable React key and a stable test handle.
  key: string;
  // "Left Cheeks · Right Sideburns", the legacy block name, or a positional
  // fallback. Never a bare first area.
  areaLabel: string;
  minutes: number | null;
  frequency: string | null;
  // "Ballet F3 · Lot #A12 (confirmed)"
  probeLine: string | null;
  modeLabel: string | null;
  modalityLabel: string | null;
  energyLevel: number | null;
  // Mode-valid only, in machine order.
  readings: PointOfCareReading[];
  hairs: number | null;
  // Live passes charted on this area. 1 for an ordinary block.
  passCount: number;
  numbing: { label: string; note: string | null } | null;
  toleranceLine: string | null;
  // Unified across the legacy reaction_type AND every live pass's chips.
  responseLine: string | null;
  // Kept whole — never truncated at 140 characters.
  responseNote: string | null;
  cautionNote: string | null;
};

export type PointOfCareMemory = {
  sessionId: string;
  startedAt: string;
  modality: string;
  // Every structured area treated in the session, deduped, with laterality.
  areaHeadline: string | null;
  totalMinutes: number | null;
  totalHairs: number | null;
  areas: PointOfCareArea[];
  // "<area>: <caution>" per flagged area, the same shape the existing
  // FromLastVisitForToday band renders.
  watchLines: string[];
  // The prior session's own next-visit note. null when the caller says the
  // charting page is already showing that exact text above the card.
  plan: string | null;
  consultationNote: PointOfCareNote | null;
  skinHairNote: PointOfCareNote | null;
  // True when a NEWER session row exists that carries no charting, so the card
  // can say so quietly instead of implying this was the very last visit.
  supersededByEmptySession: boolean;
};

const DEFAULT_EXCERPT_CHARS = 180;

// A safe, short preview of a clinical note. Cuts on a word boundary when one is
// close enough, collapses interior blank lines, and reports whether anything was
// left behind so the card can link to the full authenticated record instead of
// silently implying the note is complete.
export function noteExcerpt(
  body: string | null | undefined,
  maxChars: number = DEFAULT_EXCERPT_CHARS,
): { excerpt: string; truncated: boolean } | null {
  const normalized = (body ?? "").replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return null;
  if (normalized.length <= maxChars) {
    return { excerpt: normalized, truncated: false };
  }
  const hard = normalized.slice(0, maxChars);
  const lastSpace = hard.lastIndexOf(" ");
  const cut = lastSpace > maxChars * 0.6 ? hard.slice(0, lastSpace) : hard;
  return { excerpt: `${cut.trimEnd()}…`, truncated: true };
}

// The probe + lot line. This duplicates the read-only formatter inside
// session-blocks-view.tsx rather than extracting it: that literal is
// source-pinned by tests/app/records/record-keeping.test.ts as the health-
// inspection record's probe-lot evidence, and extracting it would move the
// pinned string out of the file the guard reads. The duplication is covered by
// this module's own unit test so the two cannot silently diverge.
function probeLine(block: PointOfCareBlock): string | null {
  const lotNumber = trimmedOrNull(block.probe_lot_number);
  const lot = lotNumber
    ? `Lot #${lotNumber}${block.probe_lot_confirmed ? " (confirmed)" : ""}`
    : null;
  const label = trimmedOrNull(block.probe_label);
  if (label) return lot ? `${label} · ${lot}` : label;
  const legacy: string[] = [];
  const type = trimmedOrNull(block.probe_type);
  const size = trimmedOrNull(block.probe_size);
  if (type) legacy.push(type);
  if (size) legacy.push(size);
  if (lot) legacy.push(lot);
  return legacy.length > 0 ? legacy.join(" · ") : null;
}

function areaLabelFor(block: PointOfCareBlock, index: number): string {
  const areas = resolveBlockAreas(block.structured_areas, {
    primary_area: block.primary_area,
    side: block.side,
  });
  if (areas.length > 0) return areas.map(formatAreaLabel).join(" · ");
  const legacyName = trimmedOrNull(block.block_name);
  if (legacyName) return legacyName;
  return `Treatment area ${index + 1}`;
}

// Mode resolution mirrors the data layer exactly
// (lib/sessions/treatment-setup-snapshot.ts:164): the block's mode wins, the
// canonical pass's mode is the fallback. Readings are gated on THAT mode, never
// on which columns happen to be populated.
function resolveMode(
  block: PointOfCareBlock,
  canonical: PointOfCareEntry | null,
): string {
  return ((block.mode ?? canonical?.mode) ?? "").trim();
}

function buildReadings(
  block: PointOfCareBlock,
  canonical: PointOfCareEntry | null,
  mode: string,
): PointOfCareReading[] {
  if (!mode) return [];
  const pulseCount = num(canonical?.pulse_count);
  const out: PointOfCareReading[] = [];

  const push = (field: ReadingField, value: string | null) => {
    if (value == null) return;
    out.push({ field, label: READING_FIELD_LABELS[field], value });
  };

  for (const field of readingFieldOrder(mode)) {
    switch (field) {
      case "energyLevel": {
        const v = num(block.energy_level);
        push(field, v != null ? `EL ${v}` : null);
        break;
      }
      case "unitsOfLye": {
        const v = num(canonical?.units_of_lye);
        push(field, v != null ? `${v} UL` : null);
        break;
      }
      case "galvanicDurationSeconds": {
        const v = num(canonical?.galvanic_duration_seconds);
        push(field, v != null ? `${v}s` : null);
        break;
      }
      case "galvanicMa": {
        const v = num(canonical?.galvanic_ma);
        push(field, v != null ? `${v} mA` : null);
        break;
      }
      case "thermolysisDurationSeconds": {
        // 3dp exact — a stored 0.733 must never render as 0.73 or 0.
        push(field, formatSeconds(num(canonical?.thermolysis_duration_seconds)));
        break;
      }
      case "thermolysisIntensityPercent": {
        const v = num(canonical?.thermolysis_intensity_percent);
        push(field, v != null ? `${v}%` : null);
        break;
      }
      case "pulseCount": {
        push(
          field,
          pulseCount != null
            ? `${pulseCount} ${pulseCount === 1 ? "pulse" : "pulses"}`
            : null,
        );
        break;
      }
      case "pulseDelay": {
        // Only meaningful between pulses: a single-pulse entry has no delay.
        const delay = num(canonical?.pulse_delay_seconds);
        push(
          field,
          pulseCount != null && pulseCount > 1 && delay != null
            ? `${delay.toFixed(2)}s delay`
            : null,
        );
        break;
      }
    }
  }
  return out;
}

function buildArea(block: PointOfCareBlock, index: number): PointOfCareArea {
  const allEntries = block.entries ?? [];
  const live = allEntries.filter((e) => e.deleted_at == null);
  // THE canonical pass — the earliest live entry, the same rule the in-form
  // "Copy settings" control uses, so the memory card and a copied draft can
  // never disagree about which pass carried the settings. firstLiveEntry reads
  // only created_at + deleted_at; the cast is because its parameter is typed
  // against the copy contract's stricter numeric shape (PostgREST may hand us
  // `numeric` columns as strings, which this module coerces itself).
  const canonical = (firstLiveEntry(
    live as unknown as ReadonlyArray<SetupSourceEntry>,
  ) ?? null) as PointOfCareEntry | null;
  const mode = resolveMode(block, canonical);

  let hairs: number | null = null;
  for (const e of live) {
    const h = num(e.hairs_treated);
    if (h != null && h > 0) hairs = (hairs ?? 0) + h;
  }

  const responseLabels = unifiedReactionLabels(
    block.reaction_type,
    live.map((e) => e.observation_chips),
  );

  const tolerance = block.tolerance_rating;

  return {
    key: block.id,
    areaLabel: areaLabelFor(block, index),
    minutes: num(block.minutes_performed),
    frequency: trimmedOrNull(block.machine_frequency),
    probeLine: probeLine(block),
    modeLabel: mode && MODE_LABELS[mode] ? MODE_LABELS[mode] : null,
    // Galvanic carries no Apilus modality; the gate lives in readingFieldOrder
    // for readings, and here for the modality chip.
    modalityLabel:
      mode !== "galv" && block.apilus_modality
        ? apilusModalityLabel(block.apilus_modality)
        : null,
    energyLevel: mode === "galv" ? null : num(block.energy_level),
    readings: buildReadings(block, canonical, mode),
    hairs,
    passCount: live.length,
    numbing: numbingDisplay(block.numbing_status, block.numbing_notes),
    toleranceLine:
      typeof tolerance === "number"
        ? `${tolerance}/5 - ${toleranceLabel(tolerance)}`
        : null,
    responseLine: responseLabels.length > 0 ? responseLabels.join(", ") : null,
    responseNote: trimmedOrNull(block.reaction_notes),
    cautionNote: trimmedOrNull(block.caution_note),
  };
}

// Every structured area treated in the session, deduped on (area, laterality)
// and rendered with laterality — "Left Cheeks · Right Sideburns". This is the
// clinical headline, where the side is part of the clinical fact. (The
// treatment-TIME breakdown deliberately buckets on the bare area instead; see
// lib/treatment-time/area-bucket.ts.)
function areaHeadline(blocks: ReadonlyArray<PointOfCareBlock>): string | null {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const block of blocks) {
    const areas = resolveBlockAreas(block.structured_areas, {
      primary_area: block.primary_area,
      side: block.side,
    });
    for (const a of areas) {
      const key = `${a.area.trim().toLowerCase()}|${a.laterality}`;
      if (seen.has(key)) continue;
      seen.add(key);
      labels.push(formatAreaLabel(a));
    }
  }
  return labels.length > 0 ? labels.join(" · ") : null;
}

export type PointOfCareMemoryInput = {
  session: {
    id: string;
    started_at: string;
    modality: string;
    next_session_note?: string | null;
  };
  blocks: ReadonlyArray<PointOfCareBlock>;
  consultationNote?: {
    occurredAt: string;
    body: string | null;
    authorName?: string | null;
    total?: number;
  } | null;
  skinHairNote?: {
    occurredAt: string;
    body: string | null;
    authorName?: string | null;
    total?: number;
  } | null;
  // The plan text the host page is ALREADY rendering above the card. When it
  // matches this session's next-visit note the card omits its own plan line, so
  // the same guidance is never shown twice.
  planAlreadyShown?: string | null;
  // True when a newer session row exists with no charting on it.
  supersededByEmptySession?: boolean;
  excerptChars?: number;
};

function toNote(
  input: {
    occurredAt: string;
    body: string | null;
    authorName?: string | null;
    total?: number;
  } | null
    | undefined,
  excerptChars: number,
): PointOfCareNote | null {
  if (!input) return null;
  const cut = noteExcerpt(input.body, excerptChars);
  if (!cut) return null;
  return {
    occurredAt: input.occurredAt,
    excerpt: cut.excerpt,
    truncated: cut.truncated,
    authorName: input.authorName ?? null,
    total: input.total ?? 1,
  };
}

// Adapter to the COMPACT pre-treatment summary (buildLastSessionSummary).
//
// The new-session page renders that summary and four other surfaces depend on
// its exact shape, so it is not being reshaped. This turns the loader's rows
// into its input instead, which is what lets both the point-of-care card and
// the "Previous session context" panel be fed from ONE query and ONE
// newest-charted-session decision rather than two divergent ones.
export function toClinicalSummaryBlocks(
  blocks: ReadonlyArray<PointOfCareBlock>,
): ClinicalSummaryBlock[] {
  return blocks.map((b) => ({
    sort_order: b.sort_order ?? 0,
    block_name: b.block_name ?? null,
    primary_area: b.primary_area ?? null,
    side: (b.side ?? null) as ClinicalSummaryBlock["side"],
    custom_area_detail: null,
    mode: (b.mode ?? null) as ClinicalSummaryBlock["mode"],
    apilus_modality: (b.apilus_modality ??
      null) as ClinicalSummaryBlock["apilus_modality"],
    energy_level: num(b.energy_level),
    minutes_performed: num(b.minutes_performed),
    probe_label: b.probe_label ?? null,
    tolerance_rating: b.tolerance_rating ?? null,
    reaction_type: b.reaction_type ?? null,
    reaction_notes: b.reaction_notes ?? null,
    caution_for_next_session: b.caution_for_next_session === true,
    caution_note: b.caution_note ?? null,
    structured_areas: (b.structured_areas ??
      null) as ClinicalSummaryBlock["structured_areas"],
    // Live passes only — a removed pass must not resurrect its reaction chips.
    observation_chips_list: (b.entries ?? [])
      .filter((e) => e.deleted_at == null)
      .map((e) => e.observation_chips),
  }));
}

export function buildPointOfCareMemory(
  input: PointOfCareMemoryInput,
): PointOfCareMemory {
  const excerptChars = input.excerptChars ?? DEFAULT_EXCERPT_CHARS;
  const ordered = [...input.blocks].sort(
    (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
  );
  const areas = ordered.map((b, i) => buildArea(b, i));

  let totalMinutes: number | null = null;
  let totalHairs: number | null = null;
  for (const a of areas) {
    if (a.minutes != null && a.minutes > 0) {
      totalMinutes = (totalMinutes ?? 0) + a.minutes;
    }
    if (a.hairs != null && a.hairs > 0) totalHairs = (totalHairs ?? 0) + a.hairs;
  }

  const watchLines: string[] = [];
  ordered.forEach((block, i) => {
    const note = trimmedOrNull(block.caution_note);
    if (!block.caution_for_next_session && !note) return;
    const name = areas[i]?.areaLabel ?? areaLabelFor(block, i);
    watchLines.push(note ? `${name}: ${note}` : `${name}: flagged to watch.`);
  });

  const ownPlan = trimmedOrNull(input.session.next_session_note);
  const alreadyShown = trimmedOrNull(input.planAlreadyShown);
  const plan = ownPlan && ownPlan !== alreadyShown ? ownPlan : null;

  return {
    sessionId: input.session.id,
    startedAt: input.session.started_at,
    modality: input.session.modality,
    areaHeadline: areaHeadline(ordered),
    totalMinutes,
    totalHairs,
    areas,
    watchLines,
    plan,
    consultationNote: toNote(input.consultationNote, excerptChars),
    skinHairNote: toNote(input.skinHairNote, excerptChars),
    supersededByEmptySession: input.supersededByEmptySession === true,
  };
}
