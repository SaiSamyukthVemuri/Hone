import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { CLINICAL_NOTES_CSV_HEADERS } from "@/lib/export/clinical-notes";

// The BEHAVIOUR of the clinical-note rows (history retention, lineage,
// attribution, serialization) is proven against the real builder and the real
// CSV writer in tests/lib/export/clinical-notes.test.ts.
//
// What a pure builder test CANNOT see is the wiring: whether the query is
// studio-scoped, whether it silently collapses history with a limit, and
// whether the file actually reaches the ZIP. That is what this file pins —
// deliberately narrow, and never a substitute for the behavioural suite.

const ACTIONS = readFileSync(
  path.resolve(__dirname, "../../../../app/(app)/settings/data/actions.ts"),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CODE = codeOnly(ACTIONS);

/** The `.from("client_clinical_notes")` call and everything up to its terminator. */
function clinicalNotesQuery(): string {
  const start = CODE.indexOf('.from("client_clinical_notes")');
  expect(start, "the export must read client_clinical_notes").toBeGreaterThan(-1);
  return CODE.slice(start, CODE.indexOf("]);", start));
}

describe("export wiring: client_clinical_notes reaches the ZIP", () => {
  it("(7) the read is scoped to the acting studio", () => {
    // Tenancy is enforced twice — this explicit filter and the 0126
    // `client_clinical_notes_member_select` RLS policy. The filter is pinned
    // because it is the half a reader can see here.
    expect(clinicalNotesQuery()).toMatch(/\.eq\("studio_id", studio\.id\)/);
  });

  it("(7) it uses the SAME authenticated client as every other export read", () => {
    // No createAdminClient / service-role widening anywhere in the export.
    expect(CODE).not.toMatch(/createAdminClient/);
    expect(clinicalNotesQuery()).toMatch(/^\.from\("client_clinical_notes"\)/);
    expect(CODE).toMatch(/const supabase = await createClient\(\);/);
  });

  it("(4) history is never collapsed — no limit, no latest-only, no distinct", () => {
    const q = clinicalNotesQuery();
    expect(q).not.toMatch(/\.limit\(/);
    expect(q).not.toMatch(/\.single\(|\.maybeSingle\(/);
    expect(q).not.toMatch(/distinct/i);
  });

  it("(8) it filters no deleted/withdrawn column — the table has none", () => {
    expect(clinicalNotesQuery()).not.toMatch(/\.is\("deleted_at"/);
  });

  it("selects every column the export contract promises", () => {
    const q = clinicalNotesQuery();
    for (const col of [
      "id",
      "client_id",
      "practitioner_id",
      "kind",
      "body",
      "areas",
      "occurred_at",
      "supersedes_note_id",
      "created_at",
    ]) {
      expect(q, `missing column ${col}`).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });

  it("the CSV is added to the ZIP through the shared rowsToCsv chokepoint", () => {
    // The chokepoint is unchanged; it is now reached through `countedCsv`,
    // the wrapper that records the manifest row count from the exact row
    // collection before delegating to rowsToCsv. Escaping the wrapper would
    // leave this file out of the manifest, which the export now refuses.
    expect(CODE).toMatch(
      /zip\.file\(\s*CLINICAL_NOTES_CSV_FILENAME,\s*countedCsv\(\s*CLINICAL_NOTES_CSV_FILENAME,\s*CLINICAL_NOTES_CSV_HEADERS,\s*buildClinicalNoteExportRows\(/,
    );
  });

  it("a query error fails the whole export rather than shipping a silent gap", () => {
    const loop = CODE.slice(CODE.indexOf("for (const r of ["));
    expect(loop.slice(0, loop.indexOf("]"))).toMatch(/clinicalNotesRes/);
  });

  it("the README and the audit manifest both name the new file", () => {
    expect(ACTIONS).toMatch(/- client_clinical_notes\.csv:/);
    expect(CODE).toMatch(/"client_clinical_notes\.csv",/);
    expect(CODE).toMatch(/client_clinical_notes: \(clinicalNotesRes\.data \?\? \[\]\)\.length/);
  });

  it("(10) the pre-existing export files are all still written", () => {
    // Adding a file must not disturb the ones owners already depend on.
    for (const f of [
      "clients.csv",
      "sessions.csv",
      "electrolysis_entries.csv",
      "laser_entries.csv",
      "practitioners.csv",
      "client_pricing.csv",
      "appointments.csv",
      "treatment_plans.csv",
      "treatment_plan_stages.csv",
      "record_keeping_sterile_items.csv",
      "record_keeping_disinfectants.csv",
      "record_keeping_exposure_incidents.csv",
      "record_keeping_audit_events.csv",
      "README.txt",
    ]) {
      expect(CODE, `${f} must still be written`).toContain(`"${f}"`);
    }
  });

  it("the owner-only gate still runs before this new read", () => {
    const gate = CODE.indexOf('practitioner.role !== "owner"');
    expect(gate).toBeGreaterThan(-1);
    expect(CODE.indexOf('.from("client_clinical_notes")')).toBeGreaterThan(gate);
  });

  it("the header list is the one the ZIP actually uses", () => {
    // Guards against the builder and the writer drifting apart.
    expect(CLINICAL_NOTES_CSV_HEADERS).toContain("supersedes_note_id");
    expect(CLINICAL_NOTES_CSV_HEADERS).toContain("kind");
    expect(CLINICAL_NOTES_CSV_HEADERS).toContain("occurred_at");
    expect(CLINICAL_NOTES_CSV_HEADERS).toContain("created_at");
  });
});
