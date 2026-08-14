// Multi-area + per-area laterality model (migration 0128, session_block_areas).
//
// A settings block (session_block) may treat several areas with the same
// machine settings, each with its own laterality. This is the pure, client-safe
// contract shared by the charting form, the block/entry display, session
// history, print and export.
//
// READ CONTRACT (documented + enforced here):
//   * If a block has session_block_areas rows, they are authoritative.
//   * Otherwise fall back to the LEGACY single area (primary_area + block-level
//     `side`, migration 0039). Legacy records keep rendering unchanged.
//
// WRITE CONTRACT: new/edited blocks persist child rows AND a safe legacy
// projection: primary_area = the first area, and block-level `side` ONLY when
// every area shares one side (never a misleading single value for mixed sides).

import type { SessionBlockSide } from "@/lib/types/database";

export type Laterality =
  | "left"
  | "right"
  | "bilateral"
  | "midline"
  | "not_applicable";

export const LATERALITY_VALUES: ReadonlyArray<Laterality> = [
  "left",
  "right",
  "bilateral",
  "midline",
  "not_applicable",
];

// Short control labels (the per-area laterality picker).
export const LATERALITY_LABELS: Record<Laterality, string> = {
  left: "Left",
  right: "Right",
  bilateral: "Both sides",
  midline: "Midline",
  not_applicable: "N/A",
};

export function isLaterality(v: unknown): v is Laterality {
  return typeof v === "string" && (LATERALITY_VALUES as readonly string[]).includes(v);
}

// A structured area as displayed (from a child row or the legacy projection).
export type BlockArea = {
  area: string;
  laterality: Laterality;
};

// Legacy block-level `side` (0039: center/left/right/bilateral/n/a) → laterality.
export function legacySideToLaterality(
  side: SessionBlockSide | string | null | undefined,
): Laterality {
  switch (side) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "bilateral":
      return "bilateral";
    case "center":
      return "midline";
    default:
      return "not_applicable";
  }
}

// Inverse projection: a shared laterality → a legacy block-level `side` value, or
// null when it does not map cleanly. Used only for the legacy `side` projection.
export function lateralityToLegacySide(lat: Laterality): SessionBlockSide | null {
  switch (lat) {
    case "left":
      return "left";
    case "right":
      return "right";
    case "bilateral":
      return "bilateral";
    case "midline":
      return "center";
    case "not_applicable":
      return "n/a";
    default:
      return null;
  }
}

// One combined label in the canonical laterality-prefix format:
// "Left cheek", "Right sideburn", "Bilateral cheeks", "Midline upper lip",
// "Neck" (not_applicable → the bare area). This is the SINGLE display format for
// every clinical surface (charting, history, summaries, print, export).
export function formatAreaLabel(area: BlockArea): string {
  const a = area.area.trim();
  switch (area.laterality) {
    case "left":
      return `Left ${a}`;
    case "right":
      return `Right ${a}`;
    case "bilateral":
      return `Bilateral ${a}`;
    case "midline":
      return `Midline ${a}`;
    case "not_applicable":
    default:
      return a;
  }
}

// One combined, ordered label for a block's treated areas: the SINGLE display
// contract for every clinical surface (charting summary, history, print, export,
// treatment-memory). Structured rows win ("Left Cheeks · Right Sideburns");
// otherwise the legacy primary_area + side ("Left Upper lip"). Returns null when
// the block has no area at all (callers fall back to block_name / a placeholder).
export function blockAreasLabel(
  structuredAreas: ReadonlyArray<BlockArea> | null | undefined,
  legacy: { primary_area?: string | null; side?: SessionBlockSide | string | null },
): string | null {
  const areas = resolveBlockAreas(structuredAreas ?? null, legacy);
  if (areas.length === 0) return null;
  return areas.map(formatAreaLabel).join(" · ");
}

// The read contract: structured child rows win; otherwise the legacy single
// area. Returns [] when neither is present (an area-less block, still valid).
export function resolveBlockAreas(
  childRows: ReadonlyArray<BlockArea> | null | undefined,
  legacy: { primary_area?: string | null; side?: SessionBlockSide | string | null },
): BlockArea[] {
  if (childRows && childRows.length > 0) {
    return childRows.map((r) => ({ area: r.area, laterality: r.laterality }));
  }
  const area = (legacy.primary_area ?? "").trim();
  if (!area) return [];
  return [{ area, laterality: legacySideToLaterality(legacy.side) }];
}

// The write-side legacy projection: keep primary_area = the first area, and set
// block-level `side` ONLY when EVERY area shares one laterality (so mixed sides
// never collapse into one misleading value: such a block gets side = null and
// its detail lives entirely in the child rows).
export function deriveLegacyProjection(areas: ReadonlyArray<BlockArea>): {
  primaryArea: string | null;
  side: SessionBlockSide | null;
} {
  if (areas.length === 0) return { primaryArea: null, side: null };
  const primaryArea = areas[0].area.trim() || null;
  const first = areas[0].laterality;
  const allSame = areas.every((a) => a.laterality === first);
  return { primaryArea, side: allSame ? lateralityToLegacySide(first) : null };
}
