// The application's side of the ONE definition of "this block holds legacy readings". The database function
// public.block_holds_legacy_readings is the authority; tests/db/machine-switches.db.test.ts pins that the two agree on a matrix of cases,
// so a change to either list fails that test. A soft-deleted entry is not a reading.

// Not included on purpose: the block's `mode` (a selection) and `machine_frequency` (a sticky default written by a save with no reading touched).
export const LEGACY_BLOCK_READING_TEXT_COLUMNS = ["apilus_modality"] as const;
export const LEGACY_BLOCK_READING_NUMBER_COLUMNS = ["energy_level"] as const;
export const LEGACY_ENTRY_READING_COLUMNS = [
  "thermolysis_intensity_percent",
  "thermolysis_duration_seconds",
  "galvanic_ma",
  "galvanic_duration_seconds",
  "units_of_lye",
  "energy_level",
  "apilus_modality",
] as const;

type Row = Record<string, unknown> | null | undefined;

const present = (v: unknown): boolean => (typeof v === "string" ? v.trim() !== "" : v !== null && v !== undefined);

export function blockHoldsLegacyReadings(block: Row, entries: ReadonlyArray<Row>): boolean {
  if (block && [...LEGACY_BLOCK_READING_TEXT_COLUMNS, ...LEGACY_BLOCK_READING_NUMBER_COLUMNS].some((k) => present(block[k]))) return true;
  return entries.some((e) => !!e && (e.deleted_at === null || e.deleted_at === undefined) && LEGACY_ENTRY_READING_COLUMNS.some((k) => present(e[k])));
}
