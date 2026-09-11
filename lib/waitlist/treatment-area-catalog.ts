// ===========================================================================
// WAIT-04A — THE TREATMENT AREAS A WAITLIST PROSPECT MAY NAME
// ===========================================================================
//
// A prospect joining a studio's new-client waitlist says what they want
// treated. That answer has to survive being read months later by a
// practitioner who was not there when it was given, and it has to be countable
// across a queue. Both rule out free text.
//
// ONE CANONICAL SOURCE, AND IT IS NOT THIS FILE. `lib/constants.ts` `AREAS` is
// Hone's treatment-area vocabulary and has been since charting shipped. This
// module does not invent a parallel list; it takes that one and removes exactly
// one member. `tests/lib/waitlist/treatment-area-catalog.test.ts` re-derives
// the expected label set FROM `AREAS` and fails if the two drift, so adding an
// area to Hone adds it here or reds the suite — it cannot silently diverge.
//
// WHY "OTHER" IS REMOVED, AND WHY THAT IS NOT A NARROWING.
// `AREAS` includes "Other" because a PRACTITIONER charting a real session must
// be able to record something the taxonomy does not have a word for; refusing
// them would lose clinical fact. `lib/sessions/area-validation.ts` accepts a
// custom string only when the caller passes `areaIsCustom: true`, which is that
// escape hatch.
//
// A PROSPECT IS NOT A PRACTITIONER, and this surface is public and
// unauthenticated. "Other" here would be a free-text box on an anonymous form
// that lands in an operator's queue: unbounded, unsearchable, unaggregatable,
// and an open channel for whatever an anonymous submitter wants to put in front
// of a studio owner. Nothing is lost clinically — the consultation is where a
// real area is recorded, by someone qualified to record it. So the catalog is
// `AREAS` minus `OTHER_AREA`, and the submission model has no free-text limb
// at all for a rejected id to fall back into.
//
// IDS ARE DECLARED, NOT DERIVED FROM LABELS. Slugifying the label would make
// the identifier a function of the copy: renaming "Lower legs" to "Calves"
// would silently repoint every stored id. The pairs below are explicit and the
// id column is frozen; a label may be re-worded, an id may not be re-used.
//
// CLIENT-SAFE ON PURPOSE. No `server-only`: the picker is a browser component
// and the catalog is public product vocabulary, not configuration.
// ===========================================================================

import { AREAS, AREA_REGIONS, OTHER_AREA } from "@/lib/constants";

/**
 * Frozen identifiers. A value here is a durable key: it may be retired, never
 * re-pointed at a different body area.
 */
export const TREATMENT_AREA_IDS = [
  "upper_lip",
  "chin",
  "jawline",
  "cheeks",
  "sideburns",
  "eyebrows",
  "full_face",
  "neck",
  "ears",
  "chest",
  "abdomen",
  "back",
  "underarms",
  "forearms",
  "hands",
  "thighs",
  "lower_legs",
  "feet",
  "bikini",
  "brazilian",
  "buttocks",
] as const;

export type TreatmentAreaId = (typeof TREATMENT_AREA_IDS)[number];

/**
 * The id ↔ canonical-label pairing.
 *
 * The label side is the EXACT string from `AREAS`, not a re-typing of it: the
 * catalog test compares this map's values against `AREAS` minus `OTHER_AREA`
 * as sets, so a typo here is a failing test rather than a second vocabulary.
 */
export const TREATMENT_AREA_LABEL: Readonly<Record<TreatmentAreaId, string>> = {
  upper_lip: "Upper lip",
  chin: "Chin",
  jawline: "Jawline",
  cheeks: "Cheeks",
  sideburns: "Sideburns",
  eyebrows: "Eyebrows",
  full_face: "Full face",
  neck: "Neck",
  ears: "Ears",
  chest: "Chest",
  abdomen: "Abdomen",
  back: "Back",
  underarms: "Underarms",
  forearms: "Forearms",
  hands: "Hands",
  thighs: "Thighs",
  lower_legs: "Lower legs",
  feet: "Feet",
  bikini: "Bikini",
  brazilian: "Brazilian",
  buttocks: "Buttocks",
};

/**
 * Region grouping for the picker.
 *
 * `AREA_REGIONS` in `lib/constants.ts` is the existing grouped taxonomy and is
 * reused verbatim for the four region NAMES and their membership. It
 * deliberately omits "Full face", because a treatment PLAN wants a specific
 * area rather than a composite — but a prospect describing what they want
 * treated is exactly the case where "Full face" is the honest answer, so it is
 * restored here, at the end of the face group where it reads as the summary of
 * the ones above it.
 *
 * The catalog test proves this grouping partitions the catalog EXACTLY: every
 * id in exactly one group, no id outside a group, no group naming an id the
 * catalog does not have.
 */
export const TREATMENT_AREA_REGIONS: ReadonlyArray<{
  region: string;
  areaIds: ReadonlyArray<TreatmentAreaId>;
}> = [
  {
    region: "Face & neck",
    areaIds: [
      "upper_lip",
      "chin",
      "jawline",
      "cheeks",
      "sideburns",
      "eyebrows",
      "neck",
      "ears",
      "full_face",
    ],
  },
  { region: "Torso", areaIds: ["chest", "abdomen", "back", "underarms"] },
  { region: "Limbs", areaIds: ["forearms", "hands", "thighs", "lower_legs", "feet"] },
  { region: "Intimate", areaIds: ["bikini", "brazilian", "buttocks"] },
];

const ID_SET: ReadonlySet<string> = new Set<string>(TREATMENT_AREA_IDS);

/** The canonical label set this catalog claims to mirror: `AREAS` less "Other". */
export function canonicalProspectAreaLabels(): ReadonlyArray<string> {
  return AREAS.filter((label) => label !== OTHER_AREA);
}

/** The region names this catalog reuses, in `lib/constants.ts` order. */
export function canonicalRegionNames(): ReadonlyArray<string> {
  return AREA_REGIONS.map((entry) => entry.region);
}

/** Type guard. The ONLY way an arbitrary string becomes a `TreatmentAreaId`. */
export function isTreatmentAreaId(value: unknown): value is TreatmentAreaId {
  return typeof value === "string" && ID_SET.has(value);
}

/** Display label for an id. */
export function treatmentAreaLabel(id: TreatmentAreaId): string {
  return TREATMENT_AREA_LABEL[id];
}

/**
 * Human-readable summary of a selection, in CATALOG order rather than the order
 * they were clicked, so the same three areas always read the same way.
 */
export function summariseTreatmentAreas(
  ids: ReadonlyArray<TreatmentAreaId>,
): string {
  const chosen = new Set<string>(ids);
  return TREATMENT_AREA_IDS.filter((id) => chosen.has(id))
    .map(treatmentAreaLabel)
    .join(", ");
}

export type AreaSelectionRefusal =
  | "not_an_array"
  | "empty_selection"
  | "unknown_area"
  | "too_many";

export type AreaSelectionResult =
  | { ok: true; value: ReadonlyArray<TreatmentAreaId> }
  | { ok: false; code: AreaSelectionRefusal };

/**
 * Upper bound on a selection.
 *
 * Not a product opinion about how much someone may want treated — it is the
 * catalog size. A submission naming more entries than the catalog holds cannot
 * be a real selection under any duplicate-free reading, so it is refused before
 * anything iterates it.
 */
export const TREATMENT_AREA_SELECTION_MAX = TREATMENT_AREA_IDS.length;

/**
 * Parse an untrusted selection into catalog ids.
 *
 * FAIL CLOSED, WHOLE-SUBMISSION. One unrecognised entry refuses the entire
 * selection rather than filtering it away. Silently dropping the unknown entry
 * would mean a prospect who typed — or a forged post that injected — an area we
 * do not offer gets a CONFIRMED waitlist join for a DIFFERENT set of areas than
 * the one submitted, with nothing on either side saying so. Refusing is the
 * only outcome that cannot quietly misrepresent what someone asked for.
 *
 * Duplicates are collapsed, not refused: selecting the same area twice is a
 * double-click, and the meaning is unambiguous.
 *
 * The result is ordered by the CATALOG, so an equivalent selection always
 * produces an equal array and downstream comparison never depends on click
 * order.
 */
export function parseTreatmentAreaIds(raw: unknown): AreaSelectionResult {
  if (!Array.isArray(raw)) return { ok: false, code: "not_an_array" };
  if (raw.length > TREATMENT_AREA_SELECTION_MAX) {
    return { ok: false, code: "too_many" };
  }
  const seen = new Set<TreatmentAreaId>();
  for (const entry of raw) {
    if (!isTreatmentAreaId(entry)) return { ok: false, code: "unknown_area" };
    seen.add(entry);
  }
  if (seen.size === 0) return { ok: false, code: "empty_selection" };
  return { ok: true, value: TREATMENT_AREA_IDS.filter((id) => seen.has(id)) };
}
