// TREATMENT-TIME AREA ATTRIBUTION, which bucket a settings block's minutes
// land in.
//
// THE DEFECT THIS FIXES
// ---------------------
// `minutes_performed` belongs to the settings BLOCK, and a block may treat
// several structured areas with one set of machine settings (migration 0128).
// The previous resolver read only the LEGACY `primary_area` projection, which
// migration 0128's write contract defines as "the FIRST area". So a block
// treating Left cheek + Right sideburn credited its entire duration to Cheek
// and the sideburn vanished from the breakdown entirely: the client had time
// on an area the report said she had never been treated on.
//
// THE PRODUCT RULE
// ----------------
// The database stores ONE block-level duration and NO allocation among the
// individual areas. Inventing a split would be fabrication. So:
//
//   * one structured area  -> that area, exactly as before;
//   * several areas        -> ONE combined bucket naming all of them, credited
//                             exactly once;
//   * no structured areas  -> the legacy fallback, unchanged.
//
// The duration is never credited to every area, never divided evenly, never
// attributed to the first area alone, and no area is ever dropped. Because each
// block still contributes to exactly one bucket, the client's global total is
// arithmetically unchanged, only the label moves.
//
// WHY BARE AREAS AND NOT "Left cheek · Right sideburn"
// ---------------------------------------------------
// This breakdown answers "which area has this client spent time on", and it has
// deliberately never fragmented by side: a left-underarm block and a
// right-underarm block both roll up into `Underarms`. Keying on the
// laterality-prefixed clinical label would silently split every existing
// single-area row in two. So the bucket key dedupes to bare area names while
// the CLINICAL surfaces (charting, history, the point-of-care memory card)
// continue to render the full `Left Cheeks · Right Sideburns` label from
// lib/sessions/block-areas.ts. Two different questions, two different labels,
// one shared area vocabulary.
//
// Pure. No I/O. Client-safe.

// Block names that are practitioner-meaningful are kept as the area label.
// Generic defaults ("Main", "Treatment 1", null) get bucketed as "Other"
// because they don't tell us a real anatomical area.
const GENERIC_BLOCK_NAME_RE = /^treatment\s+\d+$/i;

export function bucketize(blockName: string | null | undefined): string {
  if (!blockName) return "Other";
  const trimmed = blockName.trim();
  if (!trimmed) return "Other";
  if (trimmed.toLowerCase() === "main") return "Other";
  if (GENERIC_BLOCK_NAME_RE.test(trimmed)) return "Other";
  return trimmed;
}

// The join used between the areas of ONE combined bucket. Same separator the
// clinical area label uses (lib/sessions/block-areas.ts), so the two never read
// as different concepts.
export const AREA_BUCKET_SEPARATOR = " · ";

// A structured area row as stored (migration 0128). Only the ordering columns
// and the area name matter here; laterality deliberately does not participate.
export type AreaBucketRow = {
  area: string;
  display_order?: number | null;
  created_at?: string | null;
  id?: string | null;
};

export type AreaBucketBlock = {
  block_name?: string | null;
  primary_area?: string | null;
  structured_areas?: ReadonlyArray<AreaBucketRow> | null;
};

// Deterministic order, matching session_block_areas_block_order_idx:
// (display_order, created_at, id).
function orderedAreas(rows: ReadonlyArray<AreaBucketRow>): AreaBucketRow[] {
  return [...rows].sort((a, b) => {
    const ao = a.display_order ?? 0;
    const bo = b.display_order ?? 0;
    if (ao !== bo) return ao - bo;
    const ac = a.created_at ?? "";
    const bc = b.created_at ?? "";
    if (ac !== bc) return ac < bc ? -1 : 1;
    const ai = a.id ?? "";
    const bi = b.id ?? "";
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  });
}

// The whole attribution, as a pure function.
//
// It lives here rather than inline in getTreatmentTimeByArea so the invariant
// that matters: the sum of the breakdown equals the client's global total,
// is provable without a database, against the SAME code the query runs.
export type MinutesBucketBlock = AreaBucketBlock & {
  minutes_performed?: number | null;
};

export type AreaMinutesBreakdown = {
  area: string;
  minutes: number;
  percentage: number;
};

export function buildAreaMinutesBreakdown(
  blocks: ReadonlyArray<MinutesBucketBlock>,
): AreaMinutesBreakdown[] {
  const minutesByArea = new Map<string, number>();
  let total = 0;
  for (const block of blocks) {
    const minutes = block.minutes_performed ?? 0;
    if (minutes === 0) continue;
    // ONE bucket per block. Never one per area: the block carries a single
    // stored duration, so crediting each area would invent minutes the client
    // was never treated for and push the percentages past 100.
    const area = resolveAreaBucketLabel(block);
    minutesByArea.set(area, (minutesByArea.get(area) ?? 0) + minutes);
    total += minutes;
  }
  if (total === 0) return [];

  const out: AreaMinutesBreakdown[] = [];
  for (const [area, minutes] of minutesByArea) {
    out.push({
      area,
      minutes,
      percentage: Math.round((minutes / total) * 100),
    });
  }
  out.sort((a, b) => b.minutes - a.minutes);
  return out;
}

// The ONE bucket label a block's minutes are credited to.
//
// Structured rows win. They are deduped case-insensitively with the first
// spelling kept, so a block charted as [Cheek/left, Cheek/right] is one real
// area and buckets as "Cheek", not as two areas and not as a combined label
// repeating itself.
//
// The names are then sorted, because this label is an AGGREGATION KEY, not a
// description of one block. `display_order` is the practitioner's tap order
// (multi-area-editor appends each committed area to the end of the list, and
// the writer stores the index verbatim), so charting Cheek-then-Sideburn one
// visit and Sideburn-then-Cheek the next would otherwise produce two different
// keys for one anatomical combination: the client's time on that pair would
// split across two breakdown rows and the true total would appear nowhere.
// Sorting makes the key depend on the SET of areas, which is what the question
// "how long has this client spent on these areas" actually means. The CLINICAL
// label keeps charting order (lib/sessions/block-areas.ts), that one does
// describe a single block.
export function resolveAreaBucketLabel(block: AreaBucketBlock): string {
  const rows = block.structured_areas ?? [];
  if (rows.length > 0) {
    const seen = new Set<string>();
    const names: string[] = [];
    for (const row of orderedAreas(rows)) {
      const name = (row.area ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
    if (names.length > 0) {
      // Case-insensitive, locale-independent sort so the key is stable across
      // visits and across spellings.
      const canonical = [...names].sort((a, b) => {
        const al = a.toLowerCase();
        const bl = b.toLowerCase();
        return al < bl ? -1 : al > bl ? 1 : 0;
      });
      return canonical.join(AREA_BUCKET_SEPARATOR);
    }
  }
  const legacy = block.primary_area?.trim();
  if (legacy && legacy.length > 0) return legacy;
  return bucketize(block.block_name ?? null);
}
