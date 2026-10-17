import { formatSeconds } from "@/lib/sessions/format-seconds";

// ONE rule for "this entry carries STRUCTURED readings", shared by every
// renderer of a saved electrolysis entry: the saved-record view
// (components/entry-row.tsx) and the HON-46 clinical-records printout
// (lib/clinical-records/export-scope.ts), so screen and paper cannot diverge
// (Codex P1 4304983088).
//
// When an entry has structured readings (migration 0042: galvanic units of
// lye / duration / mA, thermolysis duration / intensity, or a pulse count in a
// thermo/blend mode), its legacy generic `intensity` / `duration_seconds` are
// NOT current settings: a legacy row edited through structured charting keeps
// the old pair beside the new fields (update_block_with_entry, 0166), and
// showing both would print a stale value as an active setting.
//
// Exactly entry-row's original computation: a thermolysis duration counts
// only when formatSeconds can render it (a finite number), as it did there.
export type StructuredReadingFields = {
  units_of_lye?: number | null;
  galvanic_duration_seconds?: number | null;
  galvanic_ma?: number | null;
  thermolysis_duration_seconds?: number | null;
  thermolysis_intensity_percent?: number | null;
  mode?: string | null;
  pulse_count?: number | null;
};

export function hasStructuredReadings(entry: StructuredReadingFields): boolean {
  if (entry.units_of_lye != null || entry.galvanic_duration_seconds != null || entry.galvanic_ma != null) {
    return true;
  }
  if (formatSeconds(entry.thermolysis_duration_seconds) != null) return true;
  if (entry.thermolysis_intensity_percent != null) return true;
  const thermoish = entry.mode === "thermo" || entry.mode === "blend";
  return thermoish && entry.pulse_count != null;
}
