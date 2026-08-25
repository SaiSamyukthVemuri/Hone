import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  CLINICAL_NOTES_CSV_FILENAME,
  CLINICAL_NOTES_CSV_HEADERS,
} from "@/lib/export/clinical-notes";
import {
  expectedCsvFiles,
  exportSpec,
} from "@/lib/export/resource-registry";

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
    // TRUTH-01A. The chokepoint is unchanged; it is now reached through
    // `writeCsv`, which takes the filename and the header row from the export
    // resource registry and records the manifest count from the exact row
    // collection before delegating to rowsToCsv. Escaping the wrapper would put
    // a file in the archive that the registry does not declare, which the
    // emission-parity guard refuses in both directions.
    expect(CODE).toMatch(
      /writeCsv\(\s*"client_clinical_notes",\s*buildClinicalNoteExportRows\(/,
    );
    // The registry still points at the module that owns the filename and
    // headers, so there is exactly one definition of both.
    const spec = exportSpec("client_clinical_notes");
    expect(spec.file).toBe(CLINICAL_NOTES_CSV_FILENAME);
    expect(spec.csvHeaders).toEqual([...CLINICAL_NOTES_CSV_HEADERS]);
  });

  it("a query error fails the whole export rather than shipping a silent gap", () => {
    const loop = CODE.slice(CODE.indexOf("for (const r of ["));
    expect(loop.slice(0, loop.indexOf("]"))).toMatch(/clinicalNotesRes/);
  });

  it("the README and the audit manifest both name the new file", () => {
    // Both are now GENERATED from the registry entry, so naming the file is no
    // longer something a future author can forget to do in two more places.
    // The end-to-end proof that the README lists it and the audit row counts it
    // is in tests/app/settings/data/export-emission-parity.test.ts.
    const spec = exportSpec("client_clinical_notes");
    expect(spec.description).toMatch(/clinical narrative/i);
    expect(spec.description).toMatch(/FULL HISTORY/);
    expect(ACTIONS).toMatch(/\$\{disposition\.file\}: \$\{disposition\.description\}/);
    expect(CODE).toMatch(/row_counts: Object\.fromEntries\(/);
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
      // README.txt is still a literal in the action; every CSV is now declared
      // in the registry and written through the single wrapper.
      const stillWritten =
        f === "README.txt"
          ? CODE.includes('"README.txt"')
          : expectedCsvFiles().has(f) && CODE.includes(`writeCsv("${f.replace(".csv", "")}"`);
      expect(stillWritten, `${f} must still be written`).toBe(true);
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
