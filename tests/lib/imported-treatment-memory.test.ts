import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildImportedTreatmentMemoryList,
  IMPORTED_PROVENANCE_NOTE,
  importedSourceLabel,
  toImportBatchView,
} from "@/lib/imported-treatment-memory";
import type {
  ImportBatch,
  ImportedTreatmentMemory,
} from "@/lib/types/database";

// PR #252: Imported Treatment Memory read model. The pure builder /
// label functions are tested directly; the loader's RLS / studio-scope /
// no-service-role / no-write guarantees are proven in the DB lane
// (tests/db/imported-treatment-memory.db.test.ts) and source-pinned here.

function row(over: Partial<ImportedTreatmentMemory> = {}): ImportedTreatmentMemory {
  return {
    id: "m1",
    studio_id: "s1",
    client_id: "c1",
    import_batch_id: "b1",
    source_type: "paper_card",
    source_system: null,
    source_label: null,
    source_row_number: null,
    occurred_on: "2022-05-10",
    occurred_on_text: null,
    treatment_area_text: "Upper lip",
    modality: "thermolysis",
    method_or_machine: "Apilus",
    probe_type: "Ballet",
    probe_size: "F3",
    probe_lot: "L-204",
    tolerance_text: "tolerated well",
    reaction_text: "mild redness",
    caution_note: null,
    next_visit_note: null,
    aftercare_marked: true,
    imported_note: "from paper card",
    imported_by: null,
    imported_at: "2026-06-14T00:00:00.000Z",
    voided_at: null,
    voided_by: null,
    void_reason: null,
    created_at: "2026-06-14T00:00:00.000Z",
    updated_at: "2026-06-14T00:00:00.000Z",
    ...over,
  };
}

describe("provenance labels (safe wording only)", () => {
  it("labels each source type as imported, never charted-live", () => {
    expect(importedSourceLabel("paper_card")).toBe("Imported from paper card");
    expect(importedSourceLabel("jane")).toBe("Imported from Jane");
    expect(importedSourceLabel("fresha")).toBe("Imported from Fresha");
    expect(importedSourceLabel("spreadsheet")).toBe("Imported from spreadsheet");
    expect(importedSourceLabel("other")).toBe("Imported history");
    expect(IMPORTED_PROVENANCE_NOTE).toBe(
      "Imported history, not charted live in Hone.",
    );
  });

  it("uses no advice / verified / compliance wording in any label", () => {
    const text = [
      IMPORTED_PROVENANCE_NOTE,
      importedSourceLabel("paper_card"),
      importedSourceLabel("jane"),
      importedSourceLabel("fresha"),
      importedSourceLabel("spreadsheet"),
      importedSourceLabel("other"),
    ].join(" ");
    expect(text).not.toMatch(
      /recommend|\bsafe\b|\bunsafe\b|caused|diagnos|should treat|\bverified\b|complete compliance|compliance score|\bperformance\b/i,
    );
  });
});

describe("buildImportedTreatmentMemoryList", () => {
  it("maps a row to a safe view with provenance + a date label", () => {
    const view = buildImportedTreatmentMemoryList([row()]).items[0];
    expect(view.sourceLabel).toBe("Imported from paper card");
    expect(view.provenanceNote).toBe(IMPORTED_PROVENANCE_NOTE);
    expect(view.dateLabel).toBe("2022-05-10");
    expect(view.treatmentAreaText).toBe("Upper lip");
    expect(view.probeLot).toBe("L-204");
    expect(view.voided).toBe(false);
  });

  it("falls back from clean date to messy text to 'Date not recorded'", () => {
    expect(
      buildImportedTreatmentMemoryList([
        row({ occurred_on: null, occurred_on_text: "spring '19" }),
      ]).items[0].dateLabel,
    ).toBe("spring '19");
    expect(
      buildImportedTreatmentMemoryList([
        row({ occurred_on: null, occurred_on_text: null }),
      ]).items[0].dateLabel,
    ).toBe("Date not recorded");
  });

  it("excludes voided rows by default", () => {
    const list = buildImportedTreatmentMemoryList([
      row({ id: "live" }),
      row({ id: "void", voided_at: "2026-06-14T00:00:00.000Z" }),
    ]);
    expect(list.items.map((i) => i.id)).toEqual(["live"]);
    expect(list.totalFound).toBe(1);
    expect(list.hasItems).toBe(true);
  });

  it("includes voided rows only when explicitly asked (admin/audit view)", () => {
    const list = buildImportedTreatmentMemoryList(
      [
        row({ id: "live" }),
        row({ id: "void", voided_at: "2026-06-14T00:00:00.000Z" }),
      ],
      { includeVoided: true },
    );
    expect(list.items.map((i) => i.id).sort()).toEqual(["live", "void"]);
    expect(list.items.find((i) => i.id === "void")?.voided).toBe(true);
  });

  it("orders occurred_on desc with NULLs last, then imported_at desc", () => {
    const list = buildImportedTreatmentMemoryList([
      row({ id: "old", occurred_on: "2020-01-01" }),
      row({ id: "undated", occurred_on: null, imported_at: "2026-06-14T09:00:00.000Z" }),
      row({ id: "new", occurred_on: "2023-12-31" }),
      row({ id: "undated2", occurred_on: null, imported_at: "2026-06-14T10:00:00.000Z" }),
    ]);
    expect(list.items.map((i) => i.id)).toEqual([
      "new", // 2023
      "old", // 2020
      "undated2", // null, newer import first
      "undated",
    ]);
  });

  it("caps the result and reports the pre-cap total", () => {
    const rows = Array.from({ length: 12 }, (_, n) =>
      row({ id: `m${n}`, occurred_on: `2020-01-${String(n + 1).padStart(2, "0")}` }),
    );
    const list = buildImportedTreatmentMemoryList(rows, { limit: 5 });
    expect(list.items).toHaveLength(5);
    expect(list.totalFound).toBe(12);
  });

  it("an empty input yields a calm empty list", () => {
    const list = buildImportedTreatmentMemoryList([]);
    expect(list.hasItems).toBe(false);
    expect(list.items).toEqual([]);
    expect(list.totalFound).toBe(0);
  });
});

describe("toImportBatchView", () => {
  function batch(over: Partial<ImportBatch> = {}): ImportBatch {
    return {
      id: "b1",
      studio_id: "s1",
      source_type: "spreadsheet",
      source_system: "Numbers",
      source_label: "2019 backlog",
      row_count: 42,
      created_by: null,
      created_at: "2026-06-14T00:00:00.000Z",
      completed_at: "2026-06-14T01:00:00.000Z",
      voided_at: null,
      voided_by: null,
      void_reason: null,
      updated_at: "2026-06-14T01:00:00.000Z",
      ...over,
    };
  }
  it("returns a safe, labelled batch view", () => {
    const v = toImportBatchView(batch());
    expect(v.sourceLabel).toBe("Imported from spreadsheet");
    expect(v.rowCount).toBe(42);
    expect(v.completed).toBe(true);
    expect(v.voided).toBe(false);
  });
  it("marks a voided batch", () => {
    expect(toImportBatchView(batch({ voided_at: "2026-06-14T02:00:00.000Z" })).voided).toBe(true);
  });
});

describe("safety: helper file is read-only, studio-scoped, no provider", () => {
  const SRC = readFileSync(
    join(process.cwd(), "lib/imported-treatment-memory.ts"),
    "utf8",
  );
  const executable = SRC.split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

  it("uses the RLS-backed server client, never the service role", () => {
    expect(SRC).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(executable).not.toMatch(/service.?role|SUPABASE_SERVICE_ROLE/i);
  });

  it("writes nothing and calls no model/provider", () => {
    expect(executable).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
    expect(executable).not.toMatch(/anthropic|openai|gemini|fetch\(/i);
  });

  it("every read is studio-scoped (.eq studio_id) and excludes voided by default", () => {
    expect(executable).toMatch(/\.eq\("studio_id", studioId\)/);
    expect(executable).toMatch(/\.eq\("client_id", clientId\)/);
    expect(executable).toMatch(/\.is\("voided_at", null\)/);
  });

  it("reads no sensitive surface (no audit JSON / payment / token / exposure)", () => {
    expect(executable).not.toMatch(/audit_events|changes|payment|stripe|token|exposure/i);
  });
});
