// Structured electrolysis probe taxonomy (Session Logging Phase B).
//
// The flat PROBE_TYPES / PROBE_SIZES lists in lib/constants.ts cannot
// express which brand/material/piece-type/shank/size/length combinations
// actually exist. Independent dropdowns would allow impossible probes
// (e.g. "Sterex gold F6", "Pro-Tec gold", "Ballet two-piece"). Instead
// this module enumerates the *valid* combinations from a small set of
// per-brand specs and expands them, deterministically, into a flat
// PROBE_OPTIONS catalog.
//
// v1 is a hardcoded TypeScript catalog (no DB probe_options table). The
// server actions validate the chosen option key against this catalog and
// store the decomposed fields on session_blocks. Adding a brand later is
// a code change here — no migration, because the new probe columns carry
// no DB enum/CHECK on their values.
//
// Display convention: "Stainless steel", never "SS".
//
// Deferred (intentionally NOT in this catalog): Sterex F10 Regular,
// Ballet size 12, and all blemish-removal probes.

export type ProbeBrand = "Sterex" | "Ballet" | "Pro-Tec";
export type ProbeMaterial =
  | "Stainless steel"
  | "Gold"
  | "Insulated"
  | "Isogard"
  | "Isoblend";
export type ProbePieceType = "One-piece" | "Two-piece";
export type ProbeShank = "F" | "K";
export type ProbeLength = "Short" | "Regular";

export type ProbeOption = {
  // Stable, deterministic identifier stored on session_blocks.probe_key.
  key: string;
  brand: ProbeBrand;
  material: ProbeMaterial;
  pieceType: ProbePieceType;
  shank: ProbeShank;
  // Numeric gauge as a string ("2".."6"). Stored as probe_size_value to
  // avoid colliding with the legacy free-text probe_size column.
  size: string;
  // null when the brand/piece-type doesn't distinguish length.
  length: ProbeLength | null;
  // Short within-brand label, e.g. "F3 Short", "K3 Regular", "F2".
  label: string;
  // Self-contained label stored on probe_label and shown in the UI:
  // "Sterex · Stainless steel · Two-piece · F3 Short".
  displayLabel: string;
};

// ---------------------------------------------------------------------------
// Brand specs. Each spec is expanded into ProbeOption rows below. Only
// listed (material, pieceType, shank, size, length) tuples become valid
// options — anything not listed cannot be selected.
// ---------------------------------------------------------------------------

type SizeSpec = { size: string; lengths: ReadonlyArray<ProbeLength | null> };
type VariantSpec = {
  material: ProbeMaterial;
  pieceType: ProbePieceType;
  shank: ProbeShank;
  sizes: ReadonlyArray<SizeSpec>;
};
type BrandSpec = { brand: ProbeBrand; variants: ReadonlyArray<VariantSpec> };

// Sterex is F-shank only. Two-piece comes in Stainless steel, Gold, and
// Insulated; Insulated follows the same sizing/length rules as Gold.
// One-piece is Stainless steel only (no length distinction).
const STEREX_TWO_PIECE_STEEL_SIZES: ReadonlyArray<SizeSpec> = [
  { size: "2", lengths: ["Short"] },
  { size: "3", lengths: ["Regular", "Short"] },
  { size: "4", lengths: ["Regular", "Short"] },
  { size: "5", lengths: ["Regular", "Short"] },
  { size: "6", lengths: ["Regular", "Short"] },
];
// Gold (and the identical Insulated) two-piece stops at F5.
const STEREX_TWO_PIECE_GOLD_SIZES: ReadonlyArray<SizeSpec> = [
  { size: "2", lengths: ["Short"] },
  { size: "3", lengths: ["Regular", "Short"] },
  { size: "4", lengths: ["Regular", "Short"] },
  { size: "5", lengths: ["Regular", "Short"] },
];
const STEREX_ONE_PIECE_SIZES: ReadonlyArray<SizeSpec> = [
  { size: "2", lengths: [null] },
  { size: "3", lengths: [null] },
  { size: "4", lengths: [null] },
  { size: "5", lengths: [null] },
];

const STEREX: BrandSpec = {
  brand: "Sterex",
  variants: [
    {
      material: "Stainless steel",
      pieceType: "Two-piece",
      shank: "F",
      sizes: STEREX_TWO_PIECE_STEEL_SIZES,
    },
    {
      material: "Gold",
      pieceType: "Two-piece",
      shank: "F",
      sizes: STEREX_TWO_PIECE_GOLD_SIZES,
    },
    {
      material: "Insulated",
      pieceType: "Two-piece",
      shank: "F",
      sizes: STEREX_TWO_PIECE_GOLD_SIZES,
    },
    {
      material: "Stainless steel",
      pieceType: "One-piece",
      shank: "F",
      sizes: STEREX_ONE_PIECE_SIZES,
    },
  ],
};

// Ballet is one-piece only, available in Stainless steel, Gold, and
// Insulated. Size 2 is Short and F-shank only; sizes 3-6 are Regular and
// come in both F and K shanks. (Size 12 is deferred.) Every shape exists
// in all three materials, so build the shape list once and fan out.
const BALLET_SHAPES: ReadonlyArray<{
  shank: ProbeShank;
  size: string;
  length: ProbeLength;
}> = [
  { shank: "F", size: "2", length: "Short" },
  { shank: "F", size: "3", length: "Regular" },
  { shank: "K", size: "3", length: "Regular" },
  { shank: "F", size: "4", length: "Regular" },
  { shank: "K", size: "4", length: "Regular" },
  { shank: "F", size: "5", length: "Regular" },
  { shank: "K", size: "5", length: "Regular" },
  { shank: "F", size: "6", length: "Regular" },
  { shank: "K", size: "6", length: "Regular" },
];
const BALLET_MATERIALS: ReadonlyArray<ProbeMaterial> = [
  "Stainless steel",
  "Gold",
  "Insulated",
];

function balletVariants(): ReadonlyArray<VariantSpec> {
  return BALLET_MATERIALS.flatMap((material) =>
    BALLET_SHAPES.map((shape) => ({
      material,
      pieceType: "One-piece" as const,
      shank: shape.shank,
      sizes: [{ size: shape.size, lengths: [shape.length] }],
    })),
  );
}

const BALLET: BrandSpec = {
  brand: "Ballet",
  variants: balletVariants(),
};

// Pro-Tec is two-piece only, with no gold. Isogard, Isoblend, and
// Stainless steel each span F1-F5 and K1-K5 with no length distinction.
const PROTEC_SHANKS: ReadonlyArray<ProbeShank> = ["F", "K"];
const PROTEC_SIZES: ReadonlyArray<string> = ["1", "2", "3", "4", "5"];
const PROTEC_MATERIALS: ReadonlyArray<ProbeMaterial> = [
  "Isogard",
  "Isoblend",
  "Stainless steel",
];

function protecVariants(): ReadonlyArray<VariantSpec> {
  return PROTEC_MATERIALS.flatMap((material) =>
    PROTEC_SHANKS.map((shank) => ({
      material,
      pieceType: "Two-piece" as const,
      shank,
      sizes: PROTEC_SIZES.map((size) => ({ size, lengths: [null] })),
    })),
  );
}

const PROTEC: BrandSpec = {
  brand: "Pro-Tec",
  variants: protecVariants(),
};

const BRAND_SPECS: ReadonlyArray<BrandSpec> = [STEREX, BALLET, PROTEC];

// Ordered list of brands for the picker (matches BRAND_SPECS order).
export const PROBE_BRANDS: ReadonlyArray<ProbeBrand> = BRAND_SPECS.map(
  (b) => b.brand,
);

// ---------------------------------------------------------------------------
// Expansion + label/key construction.
// ---------------------------------------------------------------------------

function slug(part: string): string {
  return part
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildLabel(
  shank: ProbeShank,
  size: string,
  length: ProbeLength | null,
): string {
  const base = `${shank}${size}`;
  return length ? `${base} ${length}` : base;
}

function buildKey(o: {
  brand: ProbeBrand;
  material: ProbeMaterial;
  pieceType: ProbePieceType;
  shank: ProbeShank;
  size: string;
  length: ProbeLength | null;
}): string {
  return [
    slug(o.brand),
    slug(o.material),
    slug(o.pieceType),
    slug(`${o.shank}${o.size}`),
    o.length ? slug(o.length) : "na",
  ].join("-");
}

function buildDisplayLabel(o: {
  brand: ProbeBrand;
  material: ProbeMaterial;
  pieceType: ProbePieceType;
  label: string;
}): string {
  return `${o.brand} · ${o.material} · ${o.pieceType} · ${o.label}`;
}

function expand(): ReadonlyArray<ProbeOption> {
  const out: ProbeOption[] = [];
  const seen = new Set<string>();
  for (const spec of BRAND_SPECS) {
    for (const variant of spec.variants) {
      for (const sizeSpec of variant.sizes) {
        for (const length of sizeSpec.lengths) {
          const label = buildLabel(variant.shank, sizeSpec.size, length);
          const key = buildKey({
            brand: spec.brand,
            material: variant.material,
            pieceType: variant.pieceType,
            shank: variant.shank,
            size: sizeSpec.size,
            length,
          });
          // Deterministic dedupe guard: specs must not produce a
          // collision. If they ever do it's a data bug, so fail loudly at
          // module load rather than silently dropping a probe.
          if (seen.has(key)) {
            throw new Error(`Duplicate probe option key generated: ${key}`);
          }
          seen.add(key);
          out.push({
            key,
            brand: spec.brand,
            material: variant.material,
            pieceType: variant.pieceType,
            shank: variant.shank,
            size: sizeSpec.size,
            length,
            label,
            displayLabel: buildDisplayLabel({
              brand: spec.brand,
              material: variant.material,
              pieceType: variant.pieceType,
              label,
            }),
          });
        }
      }
    }
  }
  return out;
}

// The flat, deterministic catalog. Order follows BRAND_SPECS → variants →
// sizes → lengths.
export const PROBE_OPTIONS: ReadonlyArray<ProbeOption> = expand();

const OPTIONS_BY_KEY: ReadonlyMap<string, ProbeOption> = new Map(
  PROBE_OPTIONS.map((o) => [o.key, o]),
);

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

export function findProbeOptionByKey(
  key: string | null | undefined,
): ProbeOption | undefined {
  if (!key) return undefined;
  return OPTIONS_BY_KEY.get(key);
}

export function isValidProbeOptionKey(key: string | null | undefined): boolean {
  return findProbeOptionByKey(key) !== undefined;
}

export function getProbeDisplayLabel(option: ProbeOption): string {
  return option.displayLabel;
}

// Grouping helpers for the cascading UI picker.

export function getMaterialsForBrand(
  brand: ProbeBrand,
): ReadonlyArray<ProbeMaterial> {
  const seen = new Set<ProbeMaterial>();
  const ordered: ProbeMaterial[] = [];
  for (const o of PROBE_OPTIONS) {
    if (o.brand !== brand) continue;
    if (seen.has(o.material)) continue;
    seen.add(o.material);
    ordered.push(o.material);
  }
  return ordered;
}

export function getProbeOptionsFor(
  brand: ProbeBrand,
  material: ProbeMaterial,
): ReadonlyArray<ProbeOption> {
  return PROBE_OPTIONS.filter(
    (o) => o.brand === brand && o.material === material,
  );
}
