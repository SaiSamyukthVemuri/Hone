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
  "waitlist-decline-answers.csv": ["answer_id", "followup_id", "entry_id", "invitation_id", "client_id", "kind", "why_not_work", "better_times", "submitted_at", "answers_erased_at"],
  "client_consent_signatures.csv": ["id", "client_id", "template_id", "template_title_snapshot", "template_body_snapshot", "template_version", "template_hash", "signature_name", "signed_at", "response", "response_label_snapshot", "created_at"],
  "probe_lots.csv": ["id", "probe_size", "lot_number", "expiry_date", "active", "notes", "created_at"],
  "service_practitioners.csv": ["id", "service_id", "practitioner_id", "created_at"],
  "services.csv": ["id", "name", "description", "default_duration_minutes", "price_cents", "active", "modality", "sort_order", "pre_care_instructions", "calendar_color", "created_at", "updated_at"],
  "treatment_goals.csv": ["id", "client_id", "estimated_total_minutes", "notes", "status", "created_at", "updated_at"],
  "appointments.csv": ["id", "client_id", "client_name", "practitioner_id", "practitioner_name", "service_id", "service_name", "starts_at", "ends_at", "duration_minutes", "status", "notes", "cancellation_reason", "cancelled_at", "cancelled_by", "created_at", "updated_at", "referral_source", "rescheduled_from_appointment_id", "rescheduled_to_appointment_id", "cancellation_kind", "booked_outside_availability"],
  "client_budget_context.csv": ["client_id", "client_name", "budget_level", "budget_notes", "updated_by_practitioner_id", "created_at", "updated_at"],
  "client_clinical_notes.csv": ["id", "client_id", "client_name", "practitioner_id", "practitioner_display_name", "kind", "body", "areas", "occurred_at", "created_at", "supersedes_note_id"],
  "client_pricing.csv": ["id", "client_id", "service_name", "price_cents", "notes", "effective_from"],
  "clients.csv": ["id", "name", "pronouns", "date_of_birth", "fitzpatrick_type", "allergies", "skin_notes", "emergency_contact_name", "emergency_contact_phone", "email", "phone", "created_at", "address", "contraindications", "photo_consent", "sms_consent_at", "sms_consent_source", "sms_opted_out_at", "sms_opt_out_source", "archived_at"],
  "electrolysis_entries.csv": ["id", "session_id", "area", "areas", "probe_size", "probe_lot_id", "mode", "intensity", "duration_seconds", "pulse_count", "comments", "created_at", "block_id", "energy_level", "apilus_modality", "machine_frequency", "minutes_performed", "probe_type", "hairs_treated", "galvanic_ma", "galvanic_duration_seconds", "galvanic_intensity_percent", "thermolysis_intensity_percent", "thermolysis_duration_seconds", "units_of_lye", "observation_chips", "block_primary_area", "block_side", "block_areas", "block_custom_area_detail", "probe_key", "probe_brand", "probe_material", "probe_piece_type", "probe_shank", "probe_size_value", "probe_length", "probe_label", "pulse_delay_seconds", "deleted_at"],
  "laser_entries.csv": ["id", "session_id", "zone", "treatment_number", "fluence", "pulse_width", "spot_size", "observation_notes", "created_at", "ejection_results", "deleted_at"],
  "practitioners.csv": ["id", "display_name", "email", "role", "active", "created_at", "color", "default_machine_frequency"],
  "record_keeping_audit_events.csv": ["id", "record_type", "record_id", "action", "changed_fields", "actor_practitioner_id", "actor_display_name", "created_at"],
  "record_keeping_disinfectants.csv": ["id", "date_prepared", "disinfectant_name", "concentration", "date_discarded", "discard_due_date", "operator_practitioner_id", "operator_name", "notes", "created_by_practitioner_id", "created_at", "updated_at"],
  "record_keeping_exposure_incidents.csv": ["id", "incident_date", "exposed_person_full_name", "exposed_person_address", "exposed_person_phone", "exposure_details", "action_taken", "staff_involved_name", "notes", "created_by_practitioner_id", "created_at", "updated_at"],
  "record_keeping_sterile_items.csv": ["id", "date_purchased", "item_description", "manufacturer_name", "amount_purchased", "lot_number", "expiry_date", "date_discarded", "notes", "created_by_practitioner_id", "created_at", "updated_at", "probe_key"],
  "sessions.csv": ["id", "client_id", "practitioner_id", "performed_by_practitioner_id", "modality", "started_at", "ended_at", "price_paid_cents", "session_notes", "created_at", "appointment_id", "treatment_plan_id", "started_at_original", "next_session_note", "aftercare_and_risks_explained_at", "record_origin", "legacy_classification"],
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
let auditFailure: "error" | "throw" | null = null;
let freshOwnerActive = true;
let revokeAtAtomicCommand = false;
let adminConstructed = 0;
// export_waitlist_decline_answers: who called it, and how many owner checks had run by then.
let actorRole = "owner";
let ownerChecks = 0;
let declineCalls: Array<{ args: Record<string, unknown>; ownerChecksBefore: number }> = [];
let declineHandler: (args: Record<string, unknown>) => { data: unknown; error: unknown } = () => ({ data: [], error: null });
let completedExportReads = 0;
/**
 * The column list the action ACTUALLY asks PostgREST for, per table. Recorded
 * from the real `.select()` call rather than read out of the source, so this is
 * observed behaviour and not a text scan of our own file.
 */
/** Tables whose read should come back as a PostgREST error for this build. */
let failingTables = new Set<string>();
/**
 * Rewrites the selection a table's query ends up sending, so a control can
 * reproduce "a later .select() replaced it" or "someone edited the literal"
 * WITHOUT editing the exporter. The stub applies it exactly where postgrest-js
 * would: on the way into the request URL.
 */
let mutateSelect: ((table: string, columns: string) => string) | null = null;

function builder(
  result: StubResult,
  table: string,
  url: URL = new URL(`http://stub/${table}`),
): unknown {
  const target = {
    url,
    then: (resolve: (v: StubResult) => unknown) => {
      completedExportReads++;
      return Promise.resolve(result).then(resolve);
    },
  };
  return new Proxy(target, {
    get(t, prop) {
      if (prop === "then") return t.then;
      if (prop === "maybeSingle" && table === "practitioners") return async () => ({
        data: { id: "prac-1", user_id: "user-1", studio_id: "studio-1", active: freshOwnerActive, role: "owner" }, error: null,
      });
      // postgrest-js keeps the selection in the REQUEST URL, and a later
      // .select() on the same builder REPLACES it. The stub models that
      // exactly, because that replacement is the behaviour the export's
      // select audit now has to survive: reading the string handed to the
      // FIRST .select() was precisely the gap Codex found.
      if (prop === "url") return t.url;
      if (prop === "select") {
        return (columns: unknown) => {
          const asked = String(columns);
          const sent = mutateSelect ? mutateSelect(table, asked) : asked;
          url.searchParams.set("select", sent.replace(/\s+/g, ""));
          return builder(result, table, url);
        };
      }
      return () => builder(result, table, url);
    },
  });
}

function makeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } }, error: null }) },
    // Synthetic atomic-command adapter, not SQL/concurrency proof.
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "export_waitlist_decline_answers") {
        declineCalls.push({ args, ownerChecksBefore: ownerChecks });
        return declineHandler(args);
      }
      expect(name).toBe("record_studio_export_audit_governed");
      expect(args).toMatchObject({ p_actor_id: "prac-1", p_user_id: "user-1", p_studio_id: "studio-1" });
      if (revokeAtAtomicCommand) freshOwnerActive = false;
      if (!freshOwnerActive) return { data: false, error: null };
      if (auditFailure === "throw") throw new Error("PRIVATE AUDIT FAILURE");
      if (auditFailure === "error") return { data: null, error: { code: "42501", message: "PRIVATE AUDIT FAILURE" } };
      auditInsert = { studio_id: args.p_studio_id, actor_id: args.p_actor_id,
        action: "studio_export", entity_type: "studio", entity_id: args.p_studio_id,
        metadata: { filename: args.p_filename, files: args.p_files, row_counts: args.p_row_counts } };
      return { data: true, error: null };
    },
    from(table: string) {
      if (table === "audit_logs") {
        return {
          insert(row: Record<string, unknown>) {
            if (auditFailure === "throw") throw new Error("PRIVATE AUDIT FAILURE");
            if (auditFailure === "error") return Promise.resolve({ error: { code: "42501", message: "PRIVATE AUDIT FAILURE" } });
            auditInsert = row;
            return Promise.resolve({ error: null });
          },
        };
      }
      return failingTables.has(table)
        ? builder(
            { data: null, error: { message: `simulated failure on ${table}` }, count: null },
            table,
          )
        : builder({ data: [], error: null, count: 0 }, table);
    },
  };
}

vi.mock("@/lib/supabase/admin-server", () => ({ createAdminClient: () => { adminConstructed++; return makeClient(); } }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => makeClient(),
}));

vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => (ownerChecks++, {
    practitioner: { id: "prac-1", user_id: "user-1", role: actorRole, active: true },
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
    failingTables = new Set();
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
// THE CHAIN — live column -> accounting -> the query THAT RAN -> the cell
// ===========================================================================
//
// Three passes were needed to get this right, and the two failures are the
// reason the controls below exist:
//
//   union BY TABLE      the practitioners display-name LOOKUP satisfied the
//                       contract for the practitioners EXPORT query;
//   a static map        a declaration says what a query SHOULD select, so an
//                       inline literal at the call site left the map correct,
//                       the audit green, and the CSV column blank.
//
// The authority is now the string handed to `.select()` at execution, recorded
// under the resource whose CSV those rows become. There is no table-level union
// anywhere in this file any more, and no second declaration to drift: the
// literal the recorder receives IS the literal the query runs.
//
// Every control here is BEHAVIOURAL — it mutates the real export and asserts
// the real refusal — because that is the only thing that can distinguish "the
// query changed" from "the description of the query changed".
describe("the chain: the query that ran must ask for what its file carries", () => {
  beforeEach(() => {
    auditInsert = null;
    failingTables = new Set();
    mutateSelect = null;
  });

  it("the emission contract holds: included means emitted", () => {
    const audit = auditEmissionContract();
    expect(audit.problems, JSON.stringify(audit.problems, null, 2)).toEqual([]);
  });

  it("CONTROL E — the real export, unmutated, succeeds", async () => {
    const zip = await buildArchive();
    expect(csvNames(zip)).toEqual([...expectedCsvFiles()].sort());
  });

  it("no table-level union or static declaration survives, here or in the exporter", () => {
    // Needle assembled at run time so this assertion is not itself a match.
    const needle = ["selects", "By", "Table"].join("");
    const self = readFileSync(__filename, "utf8");
    const action = readFileSync(
      path.resolve(__dirname, "../../../../app/(app)/settings/data/actions.ts"),
      "utf8",
    );
    expect(self.includes(needle)).toBe(false);
    expect(action.includes(needle)).toBe(false);
    // The exporter audits what the REQUEST carried, not a wrapper's argument
    // and not a declaration. Both earlier designs are gone by name.
    expect(action).toMatch(
      /auditSelectedColumns\(selectedColumnsByResource\(exportReads\)\)/,
    );
    expect(action).not.toMatch(/EXPORT_SELECTS/);
    expect(action).not.toMatch(/exportSelect/);
  });

  // -------------------------------------------------------------------------
  // CONTROLS A-C — the audit must follow the REQUEST, not the call site.
  //
  // Each mutates what the query ends up sending and asserts the real export
  // refuses. Under the previous design every one of these was GREEN: the
  // recorder held the string from the first `.select()` while the request
  // carried something narrower.
  // -------------------------------------------------------------------------
  const dropColumn = (table: string, column: string, onlyIfHas?: string) =>
    (t: string, columns: string): string => {
      if (t !== table) return columns;
      if (onlyIfHas && !columns.includes(onlyIfHas)) return columns;
      return columns
        .split(",")
        .map((c) => c.trim())
        .filter((c) => c !== column)
        .join(", ");
    };

  it("CONTROL A — a narrower second .select() on the audited query is caught", async () => {
    // The shape postgrest-js actually permits: .select(wide).select(narrow).
    mutateSelect = (table, columns) => (table === "clients" ? "id" : columns);
    await expect(buildArchive()).rejects.toThrow(/clients\./);
  });

  it("CONTROL B — a later inline .select() dropping ONE included column is caught", async () => {
    mutateSelect = dropColumn("clients", "email");
    await expect(buildArchive()).rejects.toThrow(/clients\.email/);
  });

  it("CONTROL C — practitioners EXPORT drops display_name while the LOOKUP still selects it", async () => {
    // Both queries read the same table. Only the export query is narrowed
    // (`role` appears in the export selection and not in the lookup's
    // "id, display_name"), so the lookup still asks for display_name — and it
    // must not be able to satisfy the export's contract on its behalf. This is
    // the exact confusion the by-table union had.
    mutateSelect = dropColumn("practitioners", "display_name", "role");
    await expect(buildArchive()).rejects.toThrow(/practitioners\.display_name/);
  });

  it("CONTROL D — the correct final query still succeeds", async () => {
    mutateSelect = null;
    const zip = await buildArchive();
    expect(csvNames(zip)).toEqual([...expectedCsvFiles()].sort());
  });

  it("CONTROL F — an unreadable request FAILS CLOSED rather than auditing nothing", async () => {
    // A builder whose request cannot be inspected must refuse, not silently
    // record "selected no columns" and pass the absence check.
    const { fetchExportRows } = await import("@/lib/export/provenance");
    const opaque = await fetchExportRows("clients", () =>
      Promise.resolve({ data: [], error: null }),
    );
    expect(opaque.error?.message).toMatch(/could not read the executed SELECT/);
    expect(opaque.data).toBeNull();
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

  it("names the real remaining omissions, and no longer the service menu", async () => {
    const zip = await buildArchive();
    const manifest = JSON.parse(await zip.files["manifest.json"].async("string"));
    const named = manifest.not_exported.map((r: { resource: string }) => r.resource);
    expect(named).toContain("storage:treatment-images");
    expect(named).toContain("client_intake_forms");
    expect(named).toContain("session_blocks");
    // TRUTH-01B-1 EXPORTS the service menu, so it must no longer be listed as
    // something the archive withholds. A file cannot be both.
    expect(named).not.toContain("services");
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

// ===========================================================================
// F5 — A FAILED DERIVED-AREA READ MUST FAIL THE WHOLE EXPORT
// ===========================================================================
//
// Codex P2 on 535b2e22. `session_block_areas` is read after the all-or-nothing
// guard and its error was consumed as `?? []`, so a transient PostgREST or RLS
// failure blanked every block_areas cell while the manifest still declared
// electrolysis completeness as following the sessions count and the README
// still promised that a failed page aborts the export.
describe("a failed session_block_areas read fails closed", () => {
  beforeEach(() => {
    auditInsert = null;
    failingTables = new Set();
  });

  it("refuses, and says nothing partial was written", async () => {
    failingTables = new Set(["session_block_areas"]);
    const { exportStudioDataAction } = await import(
      "@/app/(app)/settings/data/actions"
    );
    const result = await exportStudioDataAction();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/treatment areas recorded against your session blocks/i);
    expect(result.error).toMatch(/Nothing partial was written/i);
  });

  it("emits no archive and no audit claim for that run", async () => {
    failingTables = new Set(["session_block_areas"]);
    const { exportStudioDataAction } = await import(
      "@/app/(app)/settings/data/actions"
    );
    const result = await exportStudioDataAction();
    expect(result.ok).toBe(false);
    expect((result as { base64?: string }).base64).toBeUndefined();
    // The audit row is written only on success, so a refused run leaves no
    // record claiming an export happened.
    expect(auditInsert).toBeNull();
  });

  it("and the SUCCESS path is unchanged: the same archive is still produced", async () => {
    const zip = await buildArchive();
    expect(csvNames(zip)).toEqual([...expectedCsvFiles()].sort());
    expect(auditInsert).not.toBeNull();
  });
});


describe("SEC-003 actual export withholds bytes on trusted audit failure", () => {
  beforeEach(() => { auditInsert = null; failingTables = new Set(); auditFailure = null; });
  it.each(["error", "throw"] as const)("%s never returns a downloadable archive", async (mode) => {
    auditFailure = mode;
    try {
      const { exportStudioDataAction } = await import("@/app/(app)/settings/data/actions");
      const result = await exportStudioDataAction();
      expect(result).toEqual({ ok: false, error: "Could not record the export audit entry. Try again." });
      expect(result).not.toHaveProperty("base64");
      expect(result).not.toHaveProperty("filename");
      expect(auditInsert).toBeNull();
    } finally { auditFailure = null; }
  });
});


describe("SEC-003 cached owner revocation after export reads", () => {
  it("withholds real archive bytes when the cached owner is revoked before the uncached audit check", async () => {
    auditInsert = null; failingTables = new Set(); auditFailure = null;
    freshOwnerActive = true; adminConstructed = 0; completedExportReads = 0; declineCalls = [];
    const generate = JSZip.prototype.generateAsync;
    let readsAtRevocation = 0;
    const revoke = vi.spyOn(JSZip.prototype, "generateAsync").mockImplementation(function (this: JSZip, ...args) {
      // The actual caller has completed all RLS reads and is now assembling
      // real ZIP bytes. The cached resolver above STILL returns active owner.
      readsAtRevocation = completedExportReads;
      freshOwnerActive = false;
      return generate.apply(this, args);
    } as typeof generate);
    try {
      const { exportStudioDataAction } = await import("@/app/(app)/settings/data/actions");
      const result = await exportStudioDataAction();
      expect(readsAtRevocation).toBeGreaterThan(0);
      expect(revoke).toHaveBeenCalledOnce();
      const { getCurrentPractitionerWithStudio } = await import("@/lib/supabase/queries");
      expect((await getCurrentPractitionerWithStudio()).practitioner).toMatchObject({ active: true, role: "owner" });
      expect(freshOwnerActive).toBe(false);
      expect(result).toEqual({ ok: false, error: "Could not record the export audit entry. Try again." });
      expect(result).not.toHaveProperty("base64");
      expect(result).not.toHaveProperty("filename");
      expect(adminConstructed - declineCalls.length).toBe(0); // the answers read is the only admin use; the audit never got one
      expect(auditInsert).toBeNull();
    } finally { revoke.mockRestore(); freshOwnerActive = true; }
  });
});

// Stronger race oracle, preserving cached/fresh precheck proof.
describe("SEC-003 atomic write-time owner check", () => {
  it("withholds ZIP when membership is revoked AFTER the fresh app check", async () => {
    auditInsert = null; failingTables = new Set(); auditFailure = null;
    freshOwnerActive = true; adminConstructed = 0; revokeAtAtomicCommand = true; declineCalls = [];
    try {
      const { exportStudioDataAction } = await import("@/app/(app)/settings/data/actions");
      const result = await exportStudioDataAction();
      expect(freshOwnerActive).toBe(false); // Only the command mock revoked it.
      expect(adminConstructed - declineCalls.length).toBe(1); // App precheck passed; this exercises RPC denial.
      expect(auditInsert).toBeNull();
      expect(result).toEqual({ ok: false, error: "Could not record the export audit entry. Try again." });
      expect(result).not.toHaveProperty("base64");
      expect(result).not.toHaveProperty("filename");
    } finally { revokeAtAtomicCommand = false; freshOwnerActive = true; }
  });
});


// ---------------------------------------------------------------------------
// waitlist_decline_answers: exported through the owner-gated function (rpc source kind), never the raw table.
// ---------------------------------------------------------------------------
describe("the decline answers export", () => {
  const aid = (n: number, studio = "studio-1") => `${studio === "studio-1" ? "a" : "b"}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const answer = (n: number, studio = "studio-1", o: Record<string, unknown> = {}) => ({
    answer_id: aid(n, studio), followup_id: aid(n, studio), entry_id: "e", invitation_id: "i", client_id: null, kind: "decline",
    why_not_work: `SYNTHETIC-WHY-${studio}-${n}`, better_times: `SYNTHETIC-BETTER-${n}`, submitted_at: "2026-11-01T10:00:00Z", answers_erased_at: null, ...o,
  });
  const reset = () => {
    auditInsert = null; failingTables = new Set(); auditFailure = null; freshOwnerActive = true; adminConstructed = 0;
    actorRole = "owner"; ownerChecks = 0; declineCalls = []; declineHandler = () => ({ data: [], error: null });
  };
  const run = async () => {
    const { exportStudioDataAction } = await import("@/app/(app)/settings/data/actions");
    return exportStudioDataAction();
  };
  const csv = async (r: Awaited<ReturnType<typeof run>>) => {
    if (!r.ok) throw new Error(r.error);
    const zip = await JSZip.loadAsync(Buffer.from(r.base64, "base64"));
    return zip.file("waitlist-decline-answers.csv")!.async("string");
  };
  const withFlag = async (fn: () => Promise<void>) => {
    const was = process.env.WAITLIST_DECLINE_ANSWERS;
    process.env.WAITLIST_DECLINE_ANSWERS = "1";
    try { await fn(); } finally { if (was === undefined) delete process.env.WAITLIST_DECLINE_ANSWERS; else process.env.WAITLIST_DECLINE_ANSWERS = was; reset(); }
  };

  it("calls the function only after the owner check, with the studio and the SESSION user, and never reads the table", async () => {
    reset();
    await withFlag(async () => {
      declineHandler = () => ({ data: [answer(1)], error: null });
      const out = await csv(await run());
      expect(declineCalls).toHaveLength(1);
      expect(declineCalls[0].ownerChecksBefore).toBeGreaterThanOrEqual(1);
      expect(declineCalls[0].args).toMatchObject({ p_studio_id: "studio-1", p_actor_user_id: "user-1", p_after_id: null, p_limit: 1000 });
      expect(out).toContain("SYNTHETIC-WHY-studio-1-1");
    });
  });

  it("a non-owner session never reaches the function", async () => {
    reset();
    await withFlag(async () => {
      actorRole = "practitioner";
      const r = await run();
      expect(r).toEqual({ ok: false, error: "You do not have permission to export data." });
      expect(declineCalls).toHaveLength(0);
      expect(adminConstructed).toBe(0);
    });
  });

  it("an owner whose function returns nothing (a non-owner per the database) gets a header-only file", async () => {
    reset();
    await withFlag(async () => {
      const out = await csv(await run());
      expect(out.trim()).toBe("answer_id,followup_id,entry_id,invitation_id,client_id,kind,why_not_work,better_times,submitted_at,answers_erased_at");
    });
  });

  it("an erased answer exports as a marker with no text", async () => {
    reset();
    await withFlag(async () => {
      declineHandler = () => ({ data: [answer(1, "studio-1", { why_not_work: null, better_times: null, answers_erased_at: "2026-11-05T10:00:00Z" })], error: null });
      const out = await csv(await run());
      expect(out).toContain("2026-11-05T10:00:00Z");
      expect(out).not.toContain("SYNTHETIC");
    });
  });

  it("covers every page: follows p_after_id until a short page", async () => {
    reset();
    await withFlag(async () => {
      const table = Array.from({ length: 2001 }, (_, i) => answer(i + 1));
      declineHandler = (args) => {
        const after = args.p_after_id as string | null;
        return { data: table.filter((r) => after === null || r.answer_id > after).slice(0, args.p_limit as number), error: null };
      };
      const out = await csv(await run());
      expect(declineCalls.map((c) => c.args.p_after_id)).toEqual([null, aid(1000), aid(2000)]);
      expect(out.trim().split("\n")).toHaveLength(2002); // header + 2001 rows
    });
  });

  it("contains this studio's answers only", async () => {
    reset();
    await withFlag(async () => {
      const table = [answer(1), answer(2, "studio-2"), answer(3)];
      declineHandler = (args) => ({ data: table.filter((r) => (r.answer_id.startsWith("a") ? "studio-1" : "studio-2") === args.p_studio_id), error: null });
      const out = await csv(await run());
      expect(out).toContain("SYNTHETIC-WHY-studio-1-1");
      expect(out).not.toContain("studio-2");
    });
  });

  it("a failed page fails the whole export; no partial archive", async () => {
    reset();
    await withFlag(async () => {
      declineHandler = () => ({ data: null, error: { message: "SYNTHETIC-PRIVATE-ERROR" } });
      const r = await run();
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain("SYNTHETIC-PRIVATE-ERROR");
      expect(r).not.toHaveProperty("base64");
    });
  });

  it("is called with the answers flag OFF too: answers saved while it was on still export", async () => {
    reset();
    delete process.env.WAITLIST_DECLINE_ANSWERS;
    declineHandler = () => ({ data: [answer(1)], error: null });
    const r0 = await run();
    const out = await csv(r0);
    if (r0.ok) expect(JSON.parse(await (await JSZip.loadAsync(Buffer.from(r0.base64, "base64"))).file("manifest.json")!.async("string"))).not.toHaveProperty("not_available_yet");
    expect(declineCalls).toHaveLength(1);
    expect(out).toContain("SYNTHETIC-WHY-studio-1-1");
  });

  it.each(["PGRST202", "42883"])("the function not existing (%s) leaves the file out of the archive, says so in the manifest and README, and logs a code", async (code) => {
    reset();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      declineHandler = () => ({ data: null, error: { code, message: "SYNTHETIC-PRIVATE-ERROR" } });
      const r = await run();
      if (!r.ok) throw new Error(r.error);
      const zip = await JSZip.loadAsync(Buffer.from(r.base64, "base64"));
      expect(zip.file("waitlist-decline-answers.csv")).toBeNull();
      const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).toContain(code);
      expect(logged).not.toContain("SYNTHETIC-PRIVATE-ERROR");
      const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
      expect(manifest.not_available_yet).toEqual([expect.objectContaining({ file: "waitlist-decline-answers.csv", status: "not available yet" })]);
      expect(manifest.files).not.toHaveProperty("waitlist-decline-answers.csv");
      expect(await zip.file("README.txt")!.async("string")).toContain("waitlist-decline-answers.csv: NOT AVAILABLE YET");
      // the audit row is built from the archive that exists: no file the audit command does not know
      expect(JSON.stringify(auditInsert)).not.toContain("waitlist-decline-answers");
    } finally { warn.mockRestore(); }
  });

  it.each(["42501", "XX000", "22023", undefined])("any other error (%s) fails the whole export: no archive", async (code) => {
    reset();
    declineHandler = () => ({ data: null, error: { code, message: "SYNTHETIC-PRIVATE-ERROR" } });
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("base64");
    expect(JSON.stringify(r)).not.toContain("SYNTHETIC-PRIVATE-ERROR");
  });
});
