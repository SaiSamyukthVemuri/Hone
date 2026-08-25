import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import JSZip from "jszip";

import {
  auditEmissionContract,
  auditEmissionParity,
  auditExportedFilenames,
  auditSelectedColumns,
  auditSourceCountCoverage,
  exportedResources,
  expectedCsvFiles,
  pendingResources,
} from "@/lib/export/resource-registry";

// ===========================================================================
// GUARD 3 - EMISSION PARITY, and the proof that TRUTH-01A changed no payload
// ===========================================================================
//
// This suite BUILDS A REAL ARCHIVE. The older export tests read actions.ts as
// text and matched regexes against it, which can prove a line exists and can
// never prove what the ZIP contains. Everything asserted below is read back out
// of the bytes the action actually produced.
//
// The Supabase client is stubbed to a studio with no rows. That is deliberate:
// the question here is which FILES exist and what their HEADER ROWS are, and an
// empty studio answers it without inventing fixture data whose shape would then
// need its own maintenance.

// The header row every file had at the base commit, transcribed mechanically
// rather than by hand. This is the payload pin: TRUTH-01A moved the header
// arrays into the registry, and if a single column moved with them, this fails.
const BASE_CSV_HEADERS: Readonly<Record<string, readonly string[]>> = {
  "appointments.csv": ["id", "client_id", "client_name", "practitioner_id", "practitioner_name", "service_id", "service_name", "starts_at", "ends_at", "duration_minutes", "status", "notes", "cancellation_reason", "cancelled_at", "cancelled_by", "created_at", "updated_at"],
  "client_budget_context.csv": ["client_id", "client_name", "budget_level", "budget_notes", "updated_by_practitioner_id", "created_at", "updated_at"],
  "client_clinical_notes.csv": ["id", "client_id", "client_name", "practitioner_id", "practitioner_display_name", "kind", "body", "areas", "occurred_at", "created_at", "supersedes_note_id"],
  "client_pricing.csv": ["id", "client_id", "service_name", "price_cents", "notes", "effective_from"],
  "clients.csv": ["id", "name", "pronouns", "date_of_birth", "fitzpatrick_type", "allergies", "skin_notes", "emergency_contact_name", "emergency_contact_phone", "email", "phone", "created_at"],
  "electrolysis_entries.csv": ["id", "session_id", "area", "areas", "probe_size", "probe_lot_id", "mode", "intensity", "duration_seconds", "pulse_count", "comments", "created_at", "block_id", "energy_level", "apilus_modality", "machine_frequency", "minutes_performed", "probe_type", "hairs_treated", "galvanic_ma", "galvanic_duration_seconds", "galvanic_intensity_percent", "thermolysis_intensity_percent", "thermolysis_duration_seconds", "units_of_lye", "observation_chips", "block_primary_area", "block_side", "block_areas", "block_custom_area_detail", "probe_key", "probe_brand", "probe_material", "probe_piece_type", "probe_shank", "probe_size_value", "probe_length", "probe_label"],
  "laser_entries.csv": ["id", "session_id", "zone", "treatment_number", "fluence", "pulse_width", "spot_size", "observation_notes", "created_at"],
  "practitioners.csv": ["id", "display_name", "email", "role", "active", "created_at"],
  "record_keeping_audit_events.csv": ["id", "record_type", "record_id", "action", "changed_fields", "actor_practitioner_id", "actor_display_name", "created_at"],
  "record_keeping_disinfectants.csv": ["id", "date_prepared", "disinfectant_name", "concentration", "date_discarded", "discard_due_date", "operator_practitioner_id", "operator_name", "notes", "created_by_practitioner_id", "created_at", "updated_at"],
  "record_keeping_exposure_incidents.csv": ["id", "incident_date", "exposed_person_full_name", "exposed_person_address", "exposed_person_phone", "exposure_details", "action_taken", "staff_involved_name", "notes", "created_by_practitioner_id", "created_at", "updated_at"],
  "record_keeping_sterile_items.csv": ["id", "date_purchased", "item_description", "manufacturer_name", "amount_purchased", "lot_number", "expiry_date", "date_discarded", "notes", "created_by_practitioner_id", "created_at", "updated_at"],
  "sessions.csv": ["id", "client_id", "practitioner_id", "performed_by_practitioner_id", "modality", "started_at", "ended_at", "price_paid_cents", "session_notes", "created_at"],
  "treatment_plan_stages.csv": ["id", "plan_id", "plan_name", "client_id", "client_name", "sort_order", "name", "how_often_unit", "visit_length_minutes", "stage_length_value", "stage_length_unit", "notes", "created_at", "updated_at"],
  "treatment_plans.csv": ["id", "client_id", "client_name", "name", "primary_area", "treatment_areas", "estimated_timeline_months_min", "estimated_timeline_months_max", "status", "suggested_visit_count", "treatment_goal_minutes_override", "budget_notes", "practitioner_notes", "created_by_practitioner_id", "closed_by_practitioner_id", "created_at", "closed_at"],
};

// ---------------------------------------------------------------------------
// A Supabase stub that is thenable at every point in the chain, because the
// real query builder is: `fetchAllRows` awaits whatever the page factory
// returns, and the count reads await a builder mid-chain.
// ---------------------------------------------------------------------------
type StubResult = { data: unknown[] | null; error: unknown; count?: number | null };

let auditInsert: Record<string, unknown> | null = null;
/**
 * The column list the action ACTUALLY asks PostgREST for, per table. Recorded
 * from the real `.select()` call rather than read out of the source, so this is
 * observed behaviour and not a text scan of our own file.
 */
let selectsByTable: Record<string, string[]> = {};

function builder(result: StubResult, table: string): unknown {
  const target = {
    then: (resolve: (v: StubResult) => unknown) => Promise.resolve(result).then(resolve),
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "then") return t.then;
      return (...args: unknown[]) => {
        if (prop === "select" && typeof args[0] === "string") {
          // Embedded selects like `service:services(name)` are not plain
          // columns; keep only the top-level bare column names.
          const cols = (args[0] as string)
            .split(",")
            .map((c) => c.trim())
            .filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
          selectsByTable[table] = [
            ...new Set([...(selectsByTable[table] ?? []), ...cols]),
          ];
        }
        return builder(result, table);
      };
    },
  });
}

function makeClient() {
  return {
    from(table: string) {
      if (table === "audit_logs") {
        return {
          insert(row: Record<string, unknown>) {
            auditInsert = row;
            return Promise.resolve({ error: null });
          },
        };
      }
      return builder({ data: [], error: null, count: 0 }, table);
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeClient(),
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => ({
    practitioner: { id: "prac-1", role: "owner", active: true },
    studio: { id: "studio-1", name: "Willow Electrolysis" },
  }),
}));

async function buildArchive(): Promise<JSZip> {
  const { exportStudioDataAction } = await import(
    "@/app/(app)/settings/data/actions"
  );
  const result = await exportStudioDataAction();
  if (!result.ok) throw new Error(`export refused: ${result.error}`);
  return JSZip.loadAsync(Buffer.from(result.base64, "base64"));
}

function csvNames(zip: JSZip): string[] {
  return Object.entries(zip.files)
    .filter(([name, entry]) => name.endsWith(".csv") && !entry.dir)
    .map(([name]) => name)
    .sort();
}

describe("guard 3: the archive and the registry agree, both ways", () => {
  beforeEach(() => {
    auditInsert = null;
    selectsByTable = {};
  });

  it("every file the registry declares exported is in the archive", async () => {
    const zip = await buildArchive();
    const emitted = new Set(csvNames(zip));
    for (const file of expectedCsvFiles()) {
      expect(emitted.has(file), `${file} declared exported but absent`).toBe(true);
    }
  });

  it("the archive contains no CSV the registry does not declare", async () => {
    const zip = await buildArchive();
    for (const name of csvNames(zip)) {
      expect(expectedCsvFiles().has(name), `${name} emitted but undeclared`).toBe(true);
    }
  });

  it("the two sets are equal, and the archive also carries the manifest and README", async () => {
    const zip = await buildArchive();
    expect(csvNames(zip)).toEqual([...expectedCsvFiles()].sort());
    expect(zip.files["manifest.json"]).toBeDefined();
    expect(zip.files["README.txt"]).toBeDefined();
  });
});

// ===========================================================================
// THE CHAIN — live column -> accounting -> actual SELECT -> emitted header
// ===========================================================================
//
// Codex P1 on 25c066ab: Guard 2 is set arithmetic and never connects
// `includedColumns` to what the CSV carries, so a column could be DECLARED
// included while reaching no file. Three links close it, and this suite owns
// the middle one:
//
//   live DB column  -> included/excluded accounting
//                        tests/db/export-resource-registry.db.test.ts (Guard 2)
//   accounting      -> emitted header contract
//                        auditEmissionContract, below and in the DB suite
//   accounting      -> the column the exporter ACTUALLY ASKS FOR
//                        HERE, from the recorded .select() call
//   mapped value    -> the cell it lands in
//                        tests/db/export-column-round-trip.db.test.ts
//
// The SELECT is captured from the real call the action makes, not read out of
// the source: a regex over actions.ts would pass for a select string that is
// built but never used.
describe("the chain: every included column is actually selected", () => {
  it("records a SELECT for each exported resource", async () => {
    await buildArchive();
    for (const { resource } of exportedResources()) {
      expect(
        selectsByTable[resource],
        `no SELECT was observed for ${resource}`,
      ).toBeDefined();
    }
  });

  it("every declared included column appears in the observed SELECT", async () => {
    await buildArchive();
    const audit = auditSelectedColumns(selectsByTable);
    expect(
      audit.notSelected,
      "declared INCLUDED but never asked for, so the cell would be empty",
    ).toEqual([]);
    expect(audit.notObserved).toEqual([]);
  });

  it("and the emission contract holds: included means emitted", () => {
    const audit = auditEmissionContract();
    expect(audit.problems, JSON.stringify(audit.problems, null, 2)).toEqual([]);
  });
});

describe("no payload change: the header row of every file is what it was", () => {
  it("matches the base commit column-for-column, in order", async () => {
    const zip = await buildArchive();
    for (const name of csvNames(zip)) {
      const body = await zip.files[name].async("string");
      const header = body.split("\n")[0].replace(/\r$/, "");
      const expected = BASE_CSV_HEADERS[name];
      expect(expected, `${name} has no base-commit header pin`).toBeDefined();
      expect(header, `${name} header changed`).toBe(expected.join(","));
    }
  });

  it("pins one header per exported resource, so a new file cannot slip in unpinned", () => {
    expect(Object.keys(BASE_CSV_HEADERS).sort()).toEqual([...expectedCsvFiles()].sort());
  });

  it("the registry's declared headers ARE the emitted headers", async () => {
    const zip = await buildArchive();
    for (const { disposition } of exportedResources()) {
      const body = await zip.files[disposition.file].async("string");
      const header = body.split("\n")[0].replace(/\r$/, "");
      expect(header).toBe(disposition.csvHeaders.join(","));
    }
  });
});

describe("R2: the audit row describes the archive that was actually built", () => {
  it("names every CSV in the archive, plus the manifest and the README", async () => {
    const zip = await buildArchive();
    const files = (auditInsert?.metadata as { files: string[] }).files;
    expect([...files].sort()).toEqual(
      [...csvNames(zip), "README.txt", "manifest.json"].sort(),
    );
  });

  it("no longer omits the record-keeping files, which the hard-coded list did", async () => {
    await buildArchive();
    const files = (auditInsert?.metadata as { files: string[] }).files;
    for (const name of [
      "record_keeping_sterile_items.csv",
      "record_keeping_disinfectants.csv",
      "record_keeping_exposure_incidents.csv",
      "record_keeping_audit_events.csv",
      "manifest.json",
    ]) {
      expect(files, `${name} missing from the audit trail`).toContain(name);
    }
  });

  it("carries a row count for every exported resource and for nothing else", async () => {
    await buildArchive();
    const counts = (auditInsert?.metadata as { row_counts: Record<string, number> })
      .row_counts;
    expect(Object.keys(counts).sort()).toEqual(
      exportedResources().map((e) => e.resource).sort(),
    );
  });

  it("the audit counts equal the manifest counts, file for file", async () => {
    const zip = await buildArchive();
    const manifest = JSON.parse(await zip.files["manifest.json"].async("string"));
    const counts = (auditInsert?.metadata as { row_counts: Record<string, number> })
      .row_counts;
    for (const { resource, disposition } of exportedResources()) {
      expect(counts[resource]).toBe(manifest.files[disposition.file]);
    }
  });

  it("still carries no client data: metadata is filenames and counts only", async () => {
    await buildArchive();
    expect(Object.keys(auditInsert?.metadata as object).sort()).toEqual([
      "filename",
      "files",
      "row_counts",
    ]);
  });
});

describe("the manifest describes itself honestly", () => {
  it("covers every exported file in source_count_checks, not only the counted ones", async () => {
    const zip = await buildArchive();
    const manifest = JSON.parse(await zip.files["manifest.json"].async("string"));
    expect(
      manifest.source_count_checks.map((c: { table: string }) => c.table).sort(),
    ).toEqual(exportedResources().map((e) => e.resource).sort());
  });

  it("marks an unverified file not_checked with a reason, never silently", async () => {
    const zip = await buildArchive();
    const manifest = JSON.parse(await zip.files["manifest.json"].async("string"));
    const notChecked = manifest.source_count_checks.filter(
      (c: { status: string }) => c.status === "not_checked",
    );
    expect(notChecked.length).toBeGreaterThan(0);
    for (const check of notChecked) {
      expect(String(check.not_checked_reason ?? "").length).toBeGreaterThan(0);
    }
  });

  it("lists what the archive does NOT contain, from the same registry", async () => {
    const zip = await buildArchive();
    const manifest = JSON.parse(await zip.files["manifest.json"].async("string"));
    expect(
      manifest.not_exported.map((r: { resource: string }) => r.resource).sort(),
    ).toEqual(pendingResources().map((e) => e.resource).sort());
    for (const row of manifest.not_exported) {
      expect(String(row.reason).length).toBeGreaterThan(0);
      expect(String(row.ticket)).toMatch(/^TRUTH-01/);
    }
  });

  it("names treatment photos and the service menu among the omissions", async () => {
    const zip = await buildArchive();
    const manifest = JSON.parse(await zip.files["manifest.json"].async("string"));
    const named = manifest.not_exported.map((r: { resource: string }) => r.resource);
    expect(named).toContain("storage:treatment-images");
    expect(named).toContain("services");
    expect(named).toContain("client_intake_forms");
  });

  it("the export format version is unchanged by this slice", async () => {
    const zip = await buildArchive();
    const manifest = JSON.parse(await zip.files["manifest.json"].async("string"));
    expect(manifest.export_format_version).toBe(1);
  });
});

describe("the README states its own incompleteness", () => {
  it("lists every omitted resource by name", async () => {
    const zip = await buildArchive();
    const readme = await zip.files["README.txt"].async("string");
    for (const { resource } of pendingResources()) {
      expect(readme, `${resource} missing from the README omissions`).toContain(resource);
    }
  });

  it("no longer promises that leaving Hone takes every record with you", async () => {
    const zip = await buildArchive();
    const readme = await zip.files["README.txt"].async("string");
    expect(readme).not.toMatch(/your records leave with you/i);
    expect(readme).toContain("IT IS NOT EVERYTHING HONE HOLDS FOR YOUR STUDIO");
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS for the pure guards. These drive the same functions the
// action calls, with deliberately broken inputs, so a guard that has quietly
// stopped discriminating fails here rather than passing everything forever.
// ---------------------------------------------------------------------------
describe("negative controls: emission parity", () => {
  const real = [...expectedCsvFiles()];

  it("GREEN on the real set", () => {
    expect(auditEmissionParity(real).ok).toBe(true);
  });

  it("RED when a declared file is missing from the archive", () => {
    const parity = auditEmissionParity(real.filter((f) => f !== "clients.csv"));
    expect(parity.ok).toBe(false);
    expect(parity.missing).toEqual(["clients.csv"]);
  });

  it("RED when the archive holds a file nothing declares", () => {
    const parity = auditEmissionParity([...real, "surprise_table.csv"]);
    expect(parity.ok).toBe(false);
    expect(parity.unregistered).toEqual(["surprise_table.csv"]);
  });

  it("GREEN only for the ONE tolerated omission, and only when it is passed", () => {
    const withoutBudget = real.filter((f) => f !== "client_budget_context.csv");
    expect(auditEmissionParity(withoutBudget).ok).toBe(false);
    expect(
      auditEmissionParity(withoutBudget, ["client_budget_context.csv"]).ok,
    ).toBe(true);
  });

  it("a tolerated omission does not excuse a DIFFERENT missing file", () => {
    const parity = auditEmissionParity(
      real.filter((f) => f !== "client_budget_context.csv" && f !== "sessions.csv"),
      ["client_budget_context.csv"],
    );
    expect(parity.ok).toBe(false);
    expect(parity.missing).toEqual(["sessions.csv"]);
  });
});

describe("negative controls: source-count coverage", () => {
  const declared = exportedResources()
    .filter((e) => e.disposition.sourceCountCheck.kind === "studio_scoped")
    .map((e) => e.resource);

  it("GREEN when the checks performed are exactly the ones declared", () => {
    expect(auditSourceCountCoverage(declared).ok).toBe(true);
  });

  it("RED when a declared resource is absent from count-check coverage", () => {
    const audit = auditSourceCountCoverage(declared.filter((r) => r !== "clients"));
    expect(audit.ok).toBe(false);
    expect(audit.uncovered).toEqual(["clients"]);
  });

  it("RED when a check runs that no registry entry declares", () => {
    const audit = auditSourceCountCoverage([...declared, "practitioners"]);
    expect(audit.ok).toBe(false);
    expect(audit.undeclared).toEqual(["practitioners"]);
  });
});

// ---------------------------------------------------------------------------
// The registry is a DECLARATION. It must never become an access path.
// ---------------------------------------------------------------------------
describe("the registry cannot read the database", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../../../../lib/export/resource-registry.ts"),
    "utf8",
  );

  // Comments are stripped first: the registry DOCUMENTS the exporter's
  // `.select()` behaviour in prose, and prose is not a query. The invariant is
  // about executable code.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");

  it("imports no Supabase client, admin or otherwise", () => {
    expect(code).not.toMatch(/@\/lib\/supabase/);
    expect(code).not.toMatch(/createAdminClient|createClient|service_role/);
  });

  it("issues no query and calls no RPC", () => {
    expect(code).not.toMatch(/\.from\(|\.rpc\(|\.select\(/);
  });

  it("depends only on the clinical-notes CSV constants it re-declares", () => {
    const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";/gm)].map(
      (m) => m[1],
    );
    expect(imports).toEqual(["@/lib/export/clinical-notes"]);
  });

  it("the exporter still uses the RLS-scoped client, never the admin one", () => {
    const actions = readFileSync(
      path.resolve(__dirname, "../../../../app/(app)/settings/data/actions.ts"),
      "utf8",
    );
    expect(actions).not.toMatch(/createAdminClient|admin-server/);
    expect(actions).toMatch(/from "@\/lib\/supabase\/server"/);
  });
});
