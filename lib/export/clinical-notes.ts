// Studio data export — client_clinical_notes (consultation + skin/hair analysis).
//
// WHY THIS EXISTS
// ===========================================================================
// `public.client_clinical_notes` (0126/0127) is the authoritative append-only
// store for the two narrative clinical record kinds — `consultation` and
// `skin_hair_analysis`. Both are visible in the product and printable, and
// both were MISSING from the studio data export. That is a records-portability
// defect: an owner exporting "everything" received their charting, sessions,
// appointments and record-keeping, but not the clinical narrative attached to
// each client.
//
// This module is the row-shaping half only, kept pure and DB-free so the parts
// that are easy to get wrong — history retention, revision lineage, author
// attribution and serialization of free text — are unit-testable without a
// database or a ZIP. The query, the tenancy filter and the ZIP entry stay in
// app/(app)/settings/data/actions.ts, which remains the single export
// mechanism. Nothing here opens a second export path.
//
// HISTORY, NOT SNAPSHOT
// ===========================================================================
// The table is append-only: a correction is a NEW row whose
// `supersedes_note_id` points at the row it revises, and the superseded row
// stays. An export is historical portability, so EVERY row is emitted and the
// lineage column is carried verbatim. Collapsing to latest-only would silently
// discard clinical history the database deliberately preserved.
//
// There is no soft-delete on this table — no `deleted_at`, no withdrawn flag —
// so unlike `sessions` there is nothing to filter. Emitting every row IS the
// existing export policy applied honestly, not a widening of it.

// One row exactly as selected from the database. Field names mirror the 0126
// column names so a reader can line the CSV up against the schema.
export type ClinicalNoteExportSource = {
  id: string;
  client_id: string;
  practitioner_id: string;
  kind: string;
  body: string;
  areas: string[] | null;
  // Clinical event time — BACKDATABLE, and distinct from created_at.
  occurred_at: string;
  // Revision lineage: when set, this row revises that note.
  supersedes_note_id: string | null;
  // Row insert time. Both are exported: an export that kept only one could not
  // distinguish "recorded late" from "happened late".
  created_at: string;
};

// Column order is the export's contract. IDs first so a row is joinable to
// clients.csv / practitioners.csv, then the resolved display names (the same
// id-plus-readable-name pairing the record-keeping audit CSV already uses),
// then the record itself, then both timestamps, then lineage.
//
// NOTE ON WORDING: that sibling file is referred to descriptively rather than
// by its table name on purpose. `tests/app/records/audit-trail.test.ts` keeps a
// deliberately tiny allowlist of files permitted to mention that table, so the
// set of things that can touch it stays auditable at a glance. Naming it in a
// comment here would have forced that security allowlist wider for no reason.
export const CLINICAL_NOTES_CSV_HEADERS = [
  "id",
  "client_id",
  "client_name",
  "practitioner_id",
  "practitioner_display_name",
  "kind",
  "body",
  "areas",
  "occurred_at",
  "created_at",
  "supersedes_note_id",
] as const;

export const CLINICAL_NOTES_CSV_FILENAME = "client_clinical_notes.csv";

/**
 * Shape selected note rows into CSV-ready records.
 *
 * Name resolution is best-effort and never throws: a note whose author or
 * client no longer resolves keeps its ID and leaves the name blank, which is
 * the convention the appointment/audit exports already follow. Losing the row
 * because a name lookup missed would be the worse failure.
 *
 * `areas` is passed through as the array it is. `csvCell` JSON-encodes arrays,
 * which is lossless and is exactly how `electrolysis_entries.areas` already
 * exports — no second convention is invented here.
 *
 * No filtering, no de-duplication, no latest-only collapse: every row in,
 * every row out, in the order given.
 */
export function buildClinicalNoteExportRows(
  notes: ReadonlyArray<ClinicalNoteExportSource>,
  maps: {
    clientNameById: ReadonlyMap<string, string>;
    practitionerNameById: ReadonlyMap<string, string>;
  },
): Record<string, unknown>[] {
  return notes.map((n) => ({
    id: n.id,
    client_id: n.client_id,
    client_name: maps.clientNameById.get(n.client_id) ?? null,
    practitioner_id: n.practitioner_id,
    practitioner_display_name:
      maps.practitionerNameById.get(n.practitioner_id) ?? null,
    kind: n.kind,
    body: n.body,
    areas: n.areas ?? [],
    occurred_at: n.occurred_at,
    created_at: n.created_at,
    supersedes_note_id: n.supersedes_note_id,
  }));
}
