import type { RecordedReading } from "@/lib/machines/machine-queries";

/**
 * HOW MANY SETTINGS A BLOCK CURRENTLY HOLDS, for the panel's status line.
 *
 * `setup_readings_for_block` returns EVERY revision row of every group, superseded revisions and absence-only rows included, so its
 * length double-counts a revised group (a 3-field group revised once is 6 rows, 3 current settings). A group's current settings are
 * the rows at its HIGHEST revision, one per field.
 *
 * An absence row (the practitioner recorded that a field was not shown, with a reason) is NOT a setting value, so it is not counted:
 * the line says how many settings were recorded, and a recorded absence is not one.
 */
export function currentSettingCount(readings: readonly RecordedReading[]): number {
  const top = new Map<string, number>();
  for (const r of readings) top.set(r.groupKey, Math.max(top.get(r.groupKey) ?? 0, r.revision));
  const seen = new Set<string>();
  for (const r of readings) {
    if (r.revision !== top.get(r.groupKey)) continue;
    if (r.value.kind === "absent") continue;
    seen.add(`${r.groupKey}\u0000${r.fieldKey}`);
  }
  return seen.size;
}
