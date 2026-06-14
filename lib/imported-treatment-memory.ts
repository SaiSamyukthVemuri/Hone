import { createClient } from "@/lib/supabase/server";
import type {
  ImportBatch,
  ImportedTreatmentMemory,
  ImportSourceType,
} from "@/lib/types/database";

// Imported Treatment Memory read model (PR #252, migration 0089).
//
// A small, read-only, studio-scoped helper over the imported_treatment_
// memories / import_batches tables. It is the destination for HISTORICAL
// treatment memory migrated from paper cards / Jane / Fresha / spreadsheets
// -- NOT live charting. Everything here is recorded-externally history;
// the helper returns safe provenance labels and recorded-history wording
// only (imported / source / not charted live in Hone / voided), never
// advice (recommended / safe / unsafe / caused / diagnosis / verified /
// complete compliance / performance).
//
// Safety posture (mirrors the missing-records / before-today loaders):
// reads go through the RLS-backed server client (createClient); NO
// service role, NO public route, NO model/provider call, NO write.
// Voided rows are excluded by default. It exposes no audit JSON, no
// payment data, no tokens, no exposure-incident details, and never
// returns cross-studio rows (every query is studio-scoped and RLS-gated).
//
// This PR is schema + read-model only. Surfacing imported memory in
// Before Today / Treatment Intelligence / the client page is a LATER PR.

// --- Provenance labels (safe wording only) ---------------------------------

const SOURCE_LABELS: Record<ImportSourceType, string> = {
  paper_card: "Imported from paper card",
  jane: "Imported from Jane",
  fresha: "Imported from Fresha",
  spreadsheet: "Imported from spreadsheet",
  other: "Imported history",
};

// Always shown alongside imported memory so it can never be confused with
// records charted live in Hone.
export const IMPORTED_PROVENANCE_NOTE =
  "Imported history, not charted live in Hone.";

export function importedSourceLabel(sourceType: ImportSourceType): string {
  return SOURCE_LABELS[sourceType] ?? SOURCE_LABELS.other;
}

// --- View shapes -----------------------------------------------------------

export type ImportedMemoryView = {
  id: string;
  clientId: string;
  importBatchId: string;
  sourceType: ImportSourceType;
  // "Imported from paper card", etc.
  sourceLabel: string;
  // Constant reminder this is not live charting.
  provenanceNote: string;
  // Clean parsed date (YYYY-MM-DD) when available; the messy original is
  // kept too; dateLabel picks the best available, else "Date not recorded".
  occurredOn: string | null;
  occurredOnText: string | null;
  dateLabel: string;
  treatmentAreaText: string | null;
  modality: string | null;
  methodOrMachine: string | null;
  probeType: string | null;
  probeSize: string | null;
  probeLot: string | null;
  toleranceText: string | null;
  reactionText: string | null;
  cautionNote: string | null;
  nextVisitNote: string | null;
  aftercareMarked: boolean | null;
  importedNote: string | null;
  voided: boolean;
};

export type ImportedMemoryList = {
  items: ImportedMemoryView[];
  hasItems: boolean;
  // Count after void-filtering, before the display cap.
  totalFound: number;
};

export type ImportBatchView = {
  id: string;
  sourceType: ImportSourceType;
  sourceLabel: string;
  sourceSystem: string | null;
  sourceLabelText: string | null;
  rowCount: number | null;
  completed: boolean;
  voided: boolean;
  createdAt: string;
};

// Display cap (items returned) vs DB scan cap (rows read so totalFound is
// an honest pre-display-cap count). The scan cap bounds the read; the
// builder applies the display cap. A single client's imported history is
// not expected to exceed the scan cap.
const DEFAULT_MEMORY_CAP = 200;
const MEMORY_SCAN_CAP = 1000;
const DEFAULT_BATCH_CAP = 100;

function toView(row: ImportedTreatmentMemory): ImportedMemoryView {
  const dateLabel =
    row.occurred_on ??
    (row.occurred_on_text?.trim() ? row.occurred_on_text.trim() : null) ??
    "Date not recorded";
  return {
    id: row.id,
    clientId: row.client_id,
    importBatchId: row.import_batch_id,
    sourceType: row.source_type,
    sourceLabel: importedSourceLabel(row.source_type),
    provenanceNote: IMPORTED_PROVENANCE_NOTE,
    occurredOn: row.occurred_on,
    occurredOnText: row.occurred_on_text,
    dateLabel,
    treatmentAreaText: row.treatment_area_text,
    modality: row.modality,
    methodOrMachine: row.method_or_machine,
    probeType: row.probe_type,
    probeSize: row.probe_size,
    probeLot: row.probe_lot,
    toleranceText: row.tolerance_text,
    reactionText: row.reaction_text,
    cautionNote: row.caution_note,
    nextVisitNote: row.next_visit_note,
    aftercareMarked: row.aftercare_marked,
    importedNote: row.imported_note,
    voided: row.voided_at != null,
  };
}

// occurred_on desc NULLS LAST, then imported_at desc. Pure + deterministic.
function newestFirst(
  a: ImportedTreatmentMemory,
  b: ImportedTreatmentMemory,
): number {
  if (a.occurred_on !== b.occurred_on) {
    if (!a.occurred_on) return 1;
    if (!b.occurred_on) return -1;
    return a.occurred_on < b.occurred_on ? 1 : -1;
  }
  if (a.imported_at === b.imported_at) return 0;
  return a.imported_at < b.imported_at ? 1 : -1;
}

// Pure: filter voided (unless asked), order newest-first, cap, map to safe
// views. No I/O. The loader hands DB rows to this; tests exercise it
// directly without a database.
export function buildImportedTreatmentMemoryList(
  rows: ReadonlyArray<ImportedTreatmentMemory>,
  options: { includeVoided?: boolean; limit?: number } = {},
): ImportedMemoryList {
  const limit = options.limit ?? DEFAULT_MEMORY_CAP;
  const filtered = options.includeVoided
    ? [...rows]
    : rows.filter((r) => r.voided_at == null);
  filtered.sort(newestFirst);
  return {
    items: filtered.slice(0, limit).map(toView),
    hasItems: filtered.length > 0,
    totalFound: filtered.length,
  };
}

export function toImportBatchView(row: ImportBatch): ImportBatchView {
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceLabel: importedSourceLabel(row.source_type),
    sourceSystem: row.source_system,
    sourceLabelText: row.source_label,
    rowCount: row.row_count,
    completed: row.completed_at != null,
    voided: row.voided_at != null,
    createdAt: row.created_at,
  };
}

// --- Loaders (RLS-backed, studio-scoped, read-only) ------------------------

const MEMORY_COLUMNS =
  "id, studio_id, client_id, import_batch_id, source_type, source_system, " +
  "source_label, source_row_number, occurred_on, occurred_on_text, " +
  "treatment_area_text, modality, method_or_machine, probe_type, probe_size, " +
  "probe_lot, tolerance_text, reaction_text, caution_note, next_visit_note, " +
  "aftercare_marked, imported_note, imported_by, imported_at, voided_at, " +
  "voided_by, void_reason, created_at, updated_at";

// Imported memory for ONE client in ONE studio. Both filters are
// required; either missing returns an empty list (never an unscoped read).
// Voided rows are excluded unless options.includeVoided is set.
export async function getImportedTreatmentMemoriesForClient(
  studioId: string,
  clientId: string,
  options: { includeVoided?: boolean; limit?: number } = {},
): Promise<ImportedMemoryList> {
  if (!studioId || !clientId) {
    return { items: [], hasItems: false, totalFound: 0 };
  }
  const supabase = await createClient();
  let query = supabase
    .from("imported_treatment_memories")
    .select(MEMORY_COLUMNS)
    .eq("studio_id", studioId)
    .eq("client_id", clientId);
  if (!options.includeVoided) {
    query = query.is("voided_at", null);
  }
  // The DB read is bounded by the SCAN cap (not the display cap), so the
  // builder is the single capping authority and totalFound is an honest
  // pre-display-cap count.
  const { data } = await query
    .order("occurred_on", { ascending: false, nullsFirst: false })
    .order("imported_at", { ascending: false })
    .limit(MEMORY_SCAN_CAP);
  return buildImportedTreatmentMemoryList(
    (data ?? []) as unknown as ImportedTreatmentMemory[],
    { includeVoided: options.includeVoided, limit: options.limit ?? DEFAULT_MEMORY_CAP },
  );
}

const BATCH_COLUMNS =
  "id, studio_id, source_type, source_system, source_label, row_count, " +
  "created_by, created_at, completed_at, voided_at, voided_by, void_reason, " +
  "updated_at";

// Import batches for a studio (e.g. a future "import history" admin view).
// Voided batches are excluded unless options.includeVoided is set.
export async function getImportBatchesForStudio(
  studioId: string,
  options: { includeVoided?: boolean; limit?: number } = {},
): Promise<ImportBatchView[]> {
  if (!studioId) return [];
  const limit = options.limit ?? DEFAULT_BATCH_CAP;
  const supabase = await createClient();
  let query = supabase
    .from("import_batches")
    .select(BATCH_COLUMNS)
    .eq("studio_id", studioId);
  if (!options.includeVoided) {
    query = query.is("voided_at", null);
  }
  const { data } = await query
    .order("created_at", { ascending: false })
    .limit(limit);
  return ((data ?? []) as unknown as ImportBatch[]).map(toImportBatchView);
}
