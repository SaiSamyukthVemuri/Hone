import { describe, expect, it } from "vitest";

import {
  auditEmissionContract,
  auditExportedFilenames,
  auditSelectedColumns,
  duplicateFilenameError,
  exportedResources,
  type ExportedDisposition,
  type RegistryEntry,
} from "@/lib/export/resource-registry";

// ===========================================================================
// REGISTRY INVARIANTS — the negative controls, driven by fixtures
// ===========================================================================
//
// Every guard here is exercised against the REAL registry (green) and against a
// deliberately broken fixture (red). A guard with only the green case is a
// guard nobody has proved discriminates, and this file exists because two of
// the three findings on head 25c066ab were exactly that shape: an invariant
// that was stated in prose and checked over a narrower set than the prose
// described.
//
// Fixtures rather than mutations of the shared registry: these run in the fast
// unit lane beside other suites, and a temporarily corrupted module-level
// object would leak into whatever imported it next.

/** A minimal, VALID exported disposition. Each control breaks exactly one thing. */
function sound(overrides: Partial<ExportedDisposition> = {}): RegistryEntry<ExportedDisposition> {
  return {
    resource: "fixture_table",
    disposition: {
      kind: "exported",
      file: "fixture_table.csv",
      csvHeaders: ["id", "name", "owner_name"],
      includedColumns: ["id", "name"],
      excludedColumns: [{ column: "studio_id", reason: "tenant_key" }],
      derivedHeaders: { owner_name: "practitioners.display_name, joined in memory" },
      rowScope: "every row",
      sourceCountCheck: { kind: "none", reason: "fixture" },
      description: "fixture",
      ...overrides,
    },
  };
}

describe("the real registry satisfies every invariant", () => {
  it("emission contract: included means emitted, and no header is unexplained", () => {
    const audit = auditEmissionContract();
    expect(audit.problems, JSON.stringify(audit.problems, null, 2)).toEqual([]);
  });

  it("filenames are unique across exported resources", () => {
    const audit = auditExportedFilenames();
    expect(audit.duplicates).toEqual([]);
    expect(new Set(exportedResources().map((e) => e.disposition.file)).size).toBe(
      exportedResources().length,
    );
  });

  it("the only declared renames are the two laser flattenings, and they are documented", () => {
    const mapped = exportedResources().filter((e) => e.disposition.emittedAs);
    expect(mapped.map((e) => e.resource)).toEqual(["laser_entries"]);
    const m = mapped[0].disposition.emittedAs!;
    expect(m.session_number.headers).toEqual(["treatment_number"]);
    expect(m.equipment_params.headers).toEqual(["fluence", "pulse_width", "spot_size"]);
    for (const entry of Object.values(m)) {
      expect(entry.note.trim().length).toBeGreaterThan(20);
    }
  });

  it("every derived header says where it comes from", () => {
    for (const { resource, disposition } of exportedResources()) {
      for (const [header, provenance] of Object.entries(disposition.derivedHeaders ?? {})) {
        expect(
          provenance.trim().length,
          `${resource}.${header} is declared derived with no provenance`,
        ).toBeGreaterThan(10);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// FINDING 1 (P1) — the control the finding asked for, verbatim:
// "declare a column included while leaving it out of the emitted CSV" -> RED
// ---------------------------------------------------------------------------
describe("negative control: a column declared included but never emitted", () => {
  it("RED when the included column is in no header and has no mapping", () => {
    const broken = sound({
      includedColumns: ["id", "name", "contraindications"],
      excludedColumns: [],
    });
    const audit = auditEmissionContract([broken]);
    expect(audit.ok).toBe(false);
    expect(audit.problems).toContainEqual({
      resource: "fixture_table",
      kind: "included_not_emitted",
      detail:
        '"contraindications" is declared included but reaches no header: it is not in csvHeaders and has no emittedAs mapping',
    });
  });

  it("RED when a rename points at a header the file does not emit", () => {
    const broken = sound({
      includedColumns: ["id", "name", "session_number"],
      emittedAs: {
        session_number: { headers: ["treatment_number"], note: "renamed" },
      },
    });
    const audit = auditEmissionContract([broken]);
    expect(audit.ok).toBe(false);
    expect(audit.problems.map((p) => p.kind)).toContain("emitted_as_missing_header");
  });

  it("RED when a rename names a column that is not included", () => {
    const broken = sound({
      emittedAs: { ghost: { headers: ["owner_name"], note: "n/a" } },
    });
    const audit = auditEmissionContract([broken]);
    expect(audit.ok).toBe(false);
    expect(audit.problems.map((p) => p.kind)).toContain("emitted_as_unknown_column");
  });

  it("GREEN when the rename is declared and lands on a real header", () => {
    const ok = sound({
      csvHeaders: ["id", "name", "owner_name", "treatment_number"],
      includedColumns: ["id", "name", "session_number"],
      emittedAs: {
        session_number: { headers: ["treatment_number"], note: "renamed for the practitioner" },
      },
    });
    expect(auditEmissionContract([ok]).ok).toBe(true);
  });

  it("RED when a column is called excluded while the file emits it", () => {
    const broken = sound({
      includedColumns: ["id"],
      excludedColumns: [
        { column: "studio_id", reason: "tenant_key" },
        { column: "name", reason: "pending_review", note: "claimed absent" },
      ],
    });
    const audit = auditEmissionContract([broken]);
    expect(audit.ok).toBe(false);
    expect(audit.problems.map((p) => p.kind)).toContain("excluded_but_emitted");
  });

  it("RED when a header is neither a column, a rename target, nor a declared derivation", () => {
    const broken = sound({ derivedHeaders: {} });
    const audit = auditEmissionContract([broken]);
    expect(audit.ok).toBe(false);
    expect(audit.problems).toContainEqual({
      resource: "fixture_table",
      kind: "unexplained_header",
      detail:
        'header "owner_name" is neither an included column, an emittedAs target, nor a declared derivation',
    });
  });

  it("RED when a derivation is used to paper over a real column of the table", () => {
    const broken = sound({
      csvHeaders: ["id", "name"],
      includedColumns: ["id"],
      excludedColumns: [
        { column: "studio_id", reason: "tenant_key" },
        { column: "name", reason: "pending_review", note: "claimed absent" },
      ],
      derivedHeaders: { name: "pretend this comes from somewhere else" },
    });
    const audit = auditEmissionContract([broken]);
    expect(audit.ok).toBe(false);
    expect(audit.problems.map((p) => p.kind)).toContain("derived_header_shadows_column");
  });
});

// ---------------------------------------------------------------------------
// FINDING 1 (P1), middle link — declared included but never SELECTed
// ---------------------------------------------------------------------------
describe("negative control: a column declared included but never selected", () => {
  const fixture = sound();

  it("GREEN when the exporter asks for every included column", () => {
    expect(auditSelectedColumns({ fixture_table: ["id", "name", "studio_id"] }, [fixture]).ok).toBe(
      true,
    );
  });

  it("RED when an included column is missing from the SELECT", () => {
    const audit = auditSelectedColumns({ fixture_table: ["id"] }, [fixture]);
    expect(audit.ok).toBe(false);
    expect(audit.notSelected).toEqual(["fixture_table.name"]);
  });

  it("RED when no SELECT was observed at all for an exported resource", () => {
    const audit = auditSelectedColumns({}, [fixture]);
    expect(audit.ok).toBe(false);
    expect(audit.notObserved).toEqual(["fixture_table"]);
  });
});

// ---------------------------------------------------------------------------
// FINDING 2 (P2) — two resources, one filename
// ---------------------------------------------------------------------------
describe("negative control: two exported resources sharing a filename", () => {
  const a = sound();
  const b: RegistryEntry<ExportedDisposition> = {
    resource: "other_table",
    disposition: { ...sound().disposition, file: "fixture_table.csv" },
  };

  it("RED before any Set or archive operation can collapse them", () => {
    const audit = auditExportedFilenames([a, b]);
    expect(audit.ok).toBe(false);
    expect(audit.duplicates).toEqual([
      { file: "fixture_table.csv", resources: ["fixture_table", "other_table"] },
    ]);
  });

  it("the refusal names both resources and says what would have happened", () => {
    const message = duplicateFilenameError(auditExportedFilenames([a, b]));
    expect(message).toContain("fixture_table.csv");
    expect(message).toContain("fixture_table and other_table");
    expect(message).toMatch(/overwrite/);
    expect(message).toMatch(/No export was produced/);
  });

  it("GREEN once the collision is removed", () => {
    const fixed: RegistryEntry<ExportedDisposition> = {
      resource: "other_table",
      disposition: { ...sound().disposition, file: "other_table.csv" },
    };
    expect(auditExportedFilenames([a, fixed]).ok).toBe(true);
  });
});
