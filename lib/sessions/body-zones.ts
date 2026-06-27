import { AREA_REGIONS, OTHER_AREA } from "@/lib/constants";

// PR #270. Broad body zones for the built-in body-map treatment-area picker.
// Each zone maps onto the EXISTING canonical area keys (lib/constants
// AREA_REGIONS) — no new area strings are invented, so the body map and the
// list-below AreaPicker stay in sync and save identically into
// session_blocks.primary_area. This is a SCHEMATIC body map (built-in vector
// shapes), NOT an anatomical image, upload, drawing/canvas, or annotation.

export type BodyZoneId =
  | "face"
  | "neck"
  | "torso"
  | "arms"
  | "legs"
  | "intimate"
  | "other";

export type BodyZone = {
  id: BodyZoneId;
  label: string;
  // Specific canonical area keys revealed when the zone is picked. Empty for
  // "other", which defers to the free-text custom area on the list below.
  areas: ReadonlyArray<string>;
};

export const BODY_ZONES: ReadonlyArray<BodyZone> = [
  {
    id: "face",
    label: "Face",
    areas: ["Upper lip", "Chin", "Jawline", "Cheeks", "Sideburns", "Eyebrows", "Ears"],
  },
  { id: "neck", label: "Neck", areas: ["Neck"] },
  { id: "torso", label: "Torso", areas: ["Chest", "Abdomen", "Back"] },
  { id: "arms", label: "Arms", areas: ["Underarms", "Forearms", "Hands"] },
  { id: "legs", label: "Legs", areas: ["Thighs", "Lower legs", "Feet"] },
  {
    id: "intimate",
    label: "Bikini / intimate",
    areas: ["Bikini", "Brazilian", "Buttocks"],
  },
  { id: "other", label: "Other", areas: [] },
];

// Every canonical area key the AREA_REGIONS catalog defines.
const CANONICAL_AREAS: ReadonlySet<string> = new Set(
  AREA_REGIONS.flatMap((g) => g.areas),
);

// True when an area string is one the AREA_REGIONS catalog defines (i.e. a
// chip on the list-below picker), not a free-text custom value.
export function isCanonicalBodyArea(area: string): boolean {
  return CANONICAL_AREAS.has(area.trim());
}

// The zone that owns a given area value (used to highlight the active zone).
// A non-empty, non-canonical value is a custom area → the "other" zone.
// Empty/whitespace → null (nothing selected).
export function zoneForArea(area: string): BodyZoneId | null {
  const a = area.trim();
  if (!a) return null;
  for (const z of BODY_ZONES) {
    if (z.areas.includes(a)) return z.id;
  }
  return "other";
}

export { OTHER_AREA };
