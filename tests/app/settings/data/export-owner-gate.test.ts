import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  expectedCsvFiles,
  exportedResources,
  exportSpec,
} from "@/lib/export/resource-registry";
import path from "node:path";

// PR #189. exportStudioDataAction previously let ANY active
// practitioner pull the entire studio dataset (every client's
// contact info, health notes, charting history). These tests pin the
// owner-only gate and the fail-closed audit trail.

const ACTIONS = readFileSync(
  path.resolve(
    __dirname,
    "../../../../app/(app)/settings/data/actions.ts",
  ),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}
const CODE = codeOnly(ACTIONS);
const WRITER = codeOnly(readFileSync(path.resolve(__dirname, "../../../../lib/audit/governed-writes.ts"), "utf8"));
const EXPORT_WRITER = WRITER.slice(WRITER.indexOf("export async function recordStudioExportAudit"));

describe("export: owner-only gate", () => {
  it("refuses non-owner practitioners with a generic error", () => {
    expect(CODE).toMatch(
      /if \(practitioner\.role !== "owner"\) \{\s*\n?\s*return \{ ok: false, error: "You do not have permission to export data\." \};/,
    );
  });

  it("the gate runs before ANY table read", () => {
    const gateIdx = CODE.indexOf('practitioner.role !== "owner"');
    const firstReadIdx = CODE.indexOf('.from("clients")');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(firstReadIdx).toBeGreaterThan(gateIdx);
  });

  it("the refusal does not leak the role model or table names", () => {
    const refusal = "You do not have permission to export data.";
    expect(refusal).not.toMatch(/owner|role|admin/i);
  });

  it("the inactive-practitioner gate is still present", () => {
    expect(CODE).toMatch(/Inactive practitioners cannot export data\./);
  });
});

describe("export: audit trail", () => {
  it("a successful export writes an audit_logs row with the studio_export action", () => {
    expect(EXPORT_WRITER).toMatch(
      /\.from\("audit_logs"\)\.insert\(\{\s*\n?\s*studio_id: studio\.id,\s*\n?\s*actor_id: practitioner\.id,\s*\n?\s*action: "studio_export",/,
    );
  });

  it("the audit row carries entity + metadata (filename, files, row counts)", () => {
    expect(EXPORT_WRITER).toMatch(/entity_type: "studio",/);
    expect(EXPORT_WRITER).toMatch(/entity_id: studio\.id,/);
    expect(CODE).toMatch(/filename,/);
    // TRUTH-01A. `files` and `row_counts` were hand-written literals and had
    // drifted: the list named ten CSVs while the ZIP held fifteen, omitting all
    // four record_keeping_*.csv — the exposure-incident log among them. Both are
    // now DERIVED, `files` from the archive that was actually built and
    // `row_counts` from the same manifest counts. The behavioural proof that
    // they describe the real ZIP is in
    // tests/app/settings/data/export-emission-parity.test.ts.
    expect(CODE).toMatch(/rowCounts: Object\.fromEntries\(/);
    expect(EXPORT_WRITER).toContain("row_counts: { ...input.rowCounts }");
    expect(CODE).toMatch(/files: \[\.\.\.writtenCsvNames, "manifest\.json", "README\.txt"\]/);
    expect(CODE).not.toMatch(/"record_keeping_sterile_items\.csv",\s*\n\s*"record_keeping/);
  });

  it("audit insert happens after the zip is built and before the success return", () => {
    const zipIdx = CODE.indexOf("zip.generateAsync");
    const auditIdx = CODE.indexOf("await recordStudioExportAudit(");
    const returnIdx = CODE.indexOf("return { ok: true, filename, base64 };");
    expect(zipIdx).toBeGreaterThan(-1);
    expect(auditIdx).toBeGreaterThan(zipIdx);
    expect(returnIdx).toBeGreaterThan(auditIdx);
  });

  it("fails CLOSED: an audit-write failure withholds the export", () => {
    expect(CODE).toMatch(
      /if \(auditError\) \{\s*\n?\s*return \{\s*\n?\s*ok: false,\s*\n?\s*error: "Could not record the export audit entry\. Try again\.",/,
    );
  });

  it("the audit row never contains client data (metadata is names + counts only)", () => {
    const auditBlock = CODE.slice(
      CODE.indexOf("await recordStudioExportAudit("),
      CODE.indexOf("if (auditError)"),
    );
    expect(auditBlock).not.toMatch(/base64|allergies|skin_notes|email:|phone/);
  });
});

describe("PR #189 boundaries (export action)", () => {
  it("no payment / Stripe / SMS surface", () => {
    expect(CODE).not.toMatch(
      /paymentIntents|refunds\.create|charges\.create|checkout\.sessions|STRIPE_ALLOW_LIVE_MODE|twilio|sendSms/i,
    );
  });

  it("keeps export reads RLS-scoped; only the governed audit writer is privileged", () => {
    expect(ACTIONS).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ACTIONS).not.toMatch(/admin-server/);
  });
});

describe("PR #312: record-keeping / inspection CSVs", () => {
  // TRUTH-01A. Filenames left this module for the export resource registry, so
  // the pin moves with them — and gets stronger: the registry is what the
  // exporter, the manifest, the README and the audit row all read, and the
  // emission-parity guard proves the built archive matches it exactly.
  it("the ZIP includes all four record-keeping CSVs", () => {
    for (const resource of [
      "record_keeping_sterile_items",
      "record_keeping_disinfectants",
      "record_keeping_exposure_incidents",
      "record_keeping_audit_events",
    ]) {
      expect(CODE).toContain(`writeCsv("${resource}"`);
      const spec = exportSpec(resource);
      expect(spec.file).toBe(`${resource}.csv`);
      expect(expectedCsvFiles().has(spec.file)).toBe(true);
    }
  });

  // Migration 0182: the discard lifecycle must reach the inspection export.
  it("the sterile-items export SELECTS and EMITS date_discarded, and filters nothing", () => {
    // Scoped to the sterile load + its CSV writer. The export uses an EXPLICIT
    // column list in both places, so a new column reaches the inspector only if
    // it is named twice — this pin is the reason that cannot be half-done.
    const from = CODE.indexOf('fetchExportRows("record_keeping_sterile_items"');
    expect(from).toBeGreaterThan(-1);
    const load = CODE.slice(from, from + 500);
    // TRUTH-01A: the registry declares what the file carries, and the run-time
    // audit compares it against the SELECT the request actually sent...
    expect(exportSpec("record_keeping_sterile_items").includedColumns).toContain(
      "date_discarded",
    );
    // ...and the read must go through the provenance-carrying reader, which is
    // what binds the SELECT the request actually sent to this resource's audit.
    expect(load).toMatch(/fetchExportRows\(\s*"record_keeping_sterile_items"/);
    expect(load).toMatch(/date_discarded/);
    // HISTORICAL surface: a discarded row must still be exported. A lifecycle
    // predicate here would silently drop stock from a health-inspection record.
    expect(load).not.toMatch(/\.is\("date_discarded"/);
    expect(load).not.toMatch(/\.not\("date_discarded"/);

    // The emitted header row now lives in the registry, and the registry also
    // records — per column — what the inspector does NOT get and why. Both
    // halves are asserted: the column is emitted, and it is not quietly sitting
    // in the excluded list.
    const spec = exportSpec("record_keeping_sterile_items");
    expect(spec.csvHeaders).toContain("date_discarded");
    expect(spec.csvHeaders).toContain("expiry_date");
    expect(spec.includedColumns).toContain("date_discarded");
    expect(spec.excludedColumns.map((c) => c.column)).not.toContain("date_discarded");
    expect(spec.rowScope).toMatch(/discarded stock included/i);
  });

  // TRUTH-01B-1: the practitioners read was widened to carry INACTIVE rows, so
  // service_practitioners.csv and historical session rows cannot name a
  // practitioner_id that appears in no file. The registry entry is the RECORD of
  // that decision, and it went stale once already - the query dropped its
  // `active` predicate while rowScope still described one, which nothing caught
  // because rowScope has no runtime consumer. Both halves are pinned here, so
  // the query and the record can only move together.
  it("the practitioners export carries INACTIVE rows, and the registry says so", () => {
    const from = CODE.indexOf('fetchExportRows("practitioners"');
    expect(from).toBeGreaterThan(-1);
    const load = CODE.slice(from, from + 500);

    // The query: confined by studio_id, and by NOTHING ELSE.
    expect(load).toMatch(/\.eq\("studio_id", studio\.id\)/);
    expect(load).not.toMatch(/\.eq\("active"/);

    // The record must not describe a filter the query does not have.
    const spec = exportSpec("practitioners");
    expect(spec.rowScope).not.toMatch(/ACTIVE practitioners only/i);
    expect(spec.rowScope).not.toMatch(/filters active/i);
    expect(spec.rowScope).not.toMatch(/constant true/i);
    expect(spec.rowScope).toMatch(/inactive/i);

    // `active` is what keeps an exported deactivated practitioner distinguishable
    // from a current one; without it the widening would blur the two.
    expect(spec.csvHeaders).toContain("active");
    expect(spec.includedColumns).toContain("active");
  });

  it("reads each record-keeping table via the RLS client, studio-scoped", () => {
    for (const table of [
      "record_keeping_sterile_items",
      "record_keeping_disinfectants",
      "record_keeping_exposure_incidents",
      "record_keeping_audit_events",
    ]) {
      // The load block: `.from("<table>") ... .eq("studio_id", studio.id)`.
      const from = CODE.indexOf(`.from("${table}")`);
      expect(from, `missing load for ${table}`).toBeGreaterThan(-1);
      // Widened for TRUTH-01A: the select literal sits on its own lines, which
      // pushes the studio filter further down the block. The invariant is
      // unchanged — the read is studio-scoped.
      const slice = CODE.slice(from, from + 700);
      expect(slice, `${table} not studio-scoped`).toMatch(
        /\.eq\("studio_id", studio\.id\)/,
      );
    }
    // No admin/service-role client anywhere (exposure-incident owner-only RLS
    // must stay in force).
    expect(ACTIONS).not.toMatch(/createAdminClient|admin-server/);
  });

  it("exposure incidents stay behind the owner gate (before any read)", () => {
    const gateIdx = CODE.indexOf('practitioner.role !== "owner"');
    const exposureIdx = CODE.indexOf('.from("record_keeping_exposure_incidents")');
    expect(gateIdx).toBeGreaterThan(-1);
    expect(exposureIdx).toBeGreaterThan(gateIdx);
  });

  it("audit export is REDUCED — no full changes value-snapshot JSON or metadata", () => {
    // The audit load selects changed_fields (names) but NOT `changes` / `metadata`.
    const load = CODE.slice(
      CODE.indexOf('fetchExportRows("record_keeping_audit_events"'),
      CODE.indexOf('fetchExportRows("record_keeping_audit_events"') + 500,
    );
    // TRUTH-01A: the reduced column list is declared by the registry, and the
    // run-time audit holds the executed request to it.
    const reduced = exportSpec("record_keeping_audit_events").includedColumns;
    expect(reduced).toContain("changed_fields");
    expect(reduced).not.toContain("changes");
    expect(reduced).not.toContain("metadata");
    expect(load).toMatch(/fetchExportRows\(\s*"record_keeping_audit_events"/);
    // And the CSV header omits them too.
    const csv = CODE.slice(
      CODE.indexOf('"record_keeping_audit_events.csv"'),
      CODE.indexOf('"record_keeping_audit_events.csv"') + 400,
    );
    expect(csv).not.toMatch(/"changes"|"metadata"/);
  });

  it("no treatment_images CSV, no image binaries, no storage paths/buckets, no payment tables", () => {
    expect(CODE).not.toMatch(/treatment_images\.csv/);
    expect(CODE).not.toMatch(/storage_path|storage_bucket|createSignedUrl|signedUrl/);
    expect(CODE).not.toMatch(/\.from\("(payment_charge_attempts|appointment_payments|payment_consents|client_payment_methods)"\)/);
  });

  it("README warns the export contains sensitive record-keeping data", () => {
    expect(ACTIONS).toMatch(/SENSITIVE DATA/);
    expect(ACTIONS).toMatch(/exposure-incident log/i);
    // The per-file README lines are GENERATED from the registry descriptions,
    // so the warning is pinned where the text now lives. The generated README
    // is asserted end-to-end in the emission-parity suite.
    expect(ACTIONS).toMatch(/\$\{disposition\.file\}: \$\{disposition\.description\}/);
    expect(exportSpec("record_keeping_exposure_incidents").description).toMatch(
      /OWNER-ONLY/,
    );
    expect(exportSpec("record_keeping_sterile_items").description.length).toBeGreaterThan(
      40,
    );
  });

  it("no migration/schema/RLS change ships from the action (source is read-only)", () => {
    expect(CODE).not.toMatch(/alter table|create policy|drop policy|create table|\.rpc\(/i);
  });
});


// SEC-003: execute the real server-only helper, not a permissive mocked audit
// function. The production caller checks remain above; these probe its own
// authorization/scope/metadata boundary before constructing service authority.
const auditState = vi.hoisted(() => ({
  actor: { id: "actor-A", active: true, role: "owner" },
  studio: { id: "studio-A", name: "Studio A" },
  throwAuth: false, throwWrite: false,
  writeError: null as { message: string } | null,
  readError: null as { message: string } | null,
  adminConstructed: 0,
  archivedAt: null as string | null,
  auditLogs: [] as string[],
  inserted: [] as Array<Record<string, unknown>>,
  reads: [] as Array<Record<string, unknown>>,
}));
vi.mock("@/lib/supabase/queries", () => ({
  getCurrentPractitionerWithStudio: async () => {
    if (auditState.throwAuth) throw new Error("no active session");
    return { practitioner: auditState.actor, studio: auditState.studio };
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/logging/safe-log", () => ({ safeLog: { error: (value: string) => auditState.auditLogs.push(value) } }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: (table: string) => ({
    update: (patch: Record<string, unknown>) => {
      const filters: Record<string, unknown> = {};
      const chain = {
        eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
        is: () => chain, not: () => chain,
        then: (resolve: (value: unknown) => unknown) => {
          if (table !== "clients" || filters.id !== "client-A" || filters.studio_id !== "studio-A") throw new Error("mutation scope lost");
          auditState.archivedAt = patch.archived_at as string | null;
          return Promise.resolve({ error: null }).then(resolve);
        },
      };
      return chain;
    },
    select: (columns: string) => {
    const filters: Record<string, unknown> = { table, columns };
    const chain = {
      eq: (key: string, value: unknown) => { filters[key] = value; return chain; },
      maybeSingle: async () => {
        auditState.reads.push(filters);
        return { data: filters.id === "client-A" && filters.studio_id === "studio-A" ? { id: "client-A" } : null, error: auditState.readError };
      },
    };
    return chain;
  } }) }),
}));
vi.mock("@/lib/supabase/admin-server", () => ({
  createAdminClient: () => {
    auditState.adminConstructed++;
    return { from: (table: string) => ({ insert: async (row: Record<string, unknown>) => {
      if (table !== "audit_logs") throw new Error("unexpected privileged table");
      if (auditState.throwWrite) throw new Error("PRIVATE DATABASE TEXT");
      if (!auditState.writeError) auditState.inserted.push(row);
      return { error: auditState.writeError };
    } }) };
  },
}));
import { recordClientArchiveAudit, recordStudioExportAudit } from "@/lib/audit/governed-writes";

function exportAuditInput() {
  return {
    expectedStudioId: "studio-A", filename: "hone-export-studio-a-2026-10-21.zip",
    files: [...expectedCsvFiles(), "manifest.json", "README.txt"],
    rowCounts: Object.fromEntries(exportedResources().map(({ resource }) => [resource, 0])),
  };
}

describe("SEC-003 governed archive/export writer", () => {
  beforeEach(() => {
    auditState.actor = { id: "actor-A", active: true, role: "owner" };
    auditState.studio = { id: "studio-A", name: "Studio A" };
    auditState.throwAuth = false; auditState.throwWrite = false;
    auditState.writeError = null; auditState.readError = null;
    auditState.adminConstructed = 0; auditState.inserted = []; auditState.reads = [];
    auditState.archivedAt = null; auditState.auditLogs = [];
  });
  it("derives archive identity and exact metadata, ignoring caller-injected actor/action/metadata", async () => {
    const input = { expectedStudioId: "studio-A", clientId: "client-A", change: "archive" as const, archivedAt: "2026-10-21T01:00:00.000Z", actor_id: "forged", action: "clinical_records_printed", metadata: { arbitrary: "PRIVATE" } };
    expect((await recordClientArchiveAudit(input)).error).toBeNull();
    expect(auditState.reads).toEqual([{ table: "clients", columns: "id", id: "client-A", studio_id: "studio-A" }]);
    expect(auditState.inserted).toEqual([{ studio_id: "studio-A", actor_id: "actor-A", action: "client_archived", entity_type: "client", entity_id: "client-A", metadata: { archived_at: input.archivedAt } }]);
  });
  it("unarchive emits only the empty metadata object", async () => {
    auditState.actor.role = "practitioner";
    expect((await recordClientArchiveAudit({ expectedStudioId: "studio-A", clientId: "client-A", change: "unarchive", archivedAt: "ignored" })).error).toBeNull();
    expect(auditState.inserted[0]).toMatchObject({ action: "client_unarchived", metadata: {} });
  });
  it.each([
    { expectedStudioId: "studio-B", clientId: "client-A" },
    { expectedStudioId: "studio-A", clientId: "client-B" },
  ])("refuses foreign expected studio or client before service construction %j", async (scope) => {
    expect((await recordClientArchiveAudit({ ...scope, change: "unarchive" })).error).not.toBeNull();
    expect(auditState.adminConstructed).toBe(0);
  });
  it("refuses inactive/no-session/read-error cases without service writes", async () => {
    const input = { expectedStudioId: "studio-A", clientId: "client-A", change: "unarchive" as const };
    auditState.actor.active = false;
    expect((await recordClientArchiveAudit(input)).error).not.toBeNull();
    auditState.actor.active = true; auditState.throwAuth = true;
    await expect(recordClientArchiveAudit(input)).rejects.toMatchObject({ message: "Could not record the archive audit entry. Please try again." });
    auditState.throwAuth = false; auditState.readError = { message: "PRIVATE" };
    expect((await recordClientArchiveAudit(input)).error).not.toBeNull();
    expect(auditState.adminConstructed).toBe(0);
  });
  it("rejects malformed timestamps or operation, never becoming a generic clinical writer", async () => {
    expect((await recordClientArchiveAudit({ expectedStudioId: "studio-A", clientId: "client-A", change: "archive", archivedAt: "not-a-date" })).error).not.toBeNull();
    expect((await recordClientArchiveAudit({ expectedStudioId: "studio-A", clientId: "client-A", change: "clinical_records_printed" as never })).error).not.toBeNull();
    expect(auditState.adminConstructed).toBe(0);
  });
  it("exports only for the active owner, with exact bounded registry metadata", async () => {
    const input = exportAuditInput();
    expect((await recordStudioExportAudit(input)).error).toBeNull();
    expect(auditState.inserted[0]).toEqual({ studio_id: "studio-A", actor_id: "actor-A", action: "studio_export", entity_type: "studio", entity_id: "studio-A", metadata: { filename: input.filename, files: input.files, row_counts: input.rowCounts } });
  });
  it("rejects nonowner, inactive and changed-studio export contexts", async () => {
    auditState.actor.role = "practitioner";
    expect((await recordStudioExportAudit(exportAuditInput())).error).not.toBeNull();
    auditState.actor.role = "owner"; auditState.actor.active = false;
    expect((await recordStudioExportAudit(exportAuditInput())).error).not.toBeNull();
    auditState.actor.active = true;
    expect((await recordStudioExportAudit({ ...exportAuditInput(), expectedStudioId: "studio-B" })).error).not.toBeNull();
    expect(auditState.adminConstructed).toBe(0);
  });
  it("refuses ungoverned files, counts, filename and incomplete metadata", async () => {
    const input = exportAuditInput();
    for (const mutation of [
      { files: [...input.files, "arbitrary-provider-text.csv"] },
      { files: [...input.files, "README.txt"] },
      { files: input.files.filter((f) => f !== "manifest.json") },
      { filename: "hone-export-other-studio-2026-10-21.zip" },
      { rowCounts: { ...input.rowCounts, arbitrary: 1 } },
      { rowCounts: Object.fromEntries(Object.keys(input.rowCounts).map((key) => [key, -1])) },
    ]) expect((await recordStudioExportAudit({ ...input, ...mutation })).error).not.toBeNull();
    expect(auditState.adminConstructed).toBe(0);
  });
  it.each(["archiveClientAction", "unarchiveClientAction"] as const)("%s preserves best-effort returned audit errors", async (action) => {
    const actions = await import("@/app/(app)/clients/[id]/actions");
    const form = new FormData(); form.set("client_id", "client-A");
    auditState.archivedAt = action === "unarchiveClientAction" ? "2026-10-20T00:00:00.000Z" : null;
    auditState.writeError = { message: "PRIVATE DATABASE TEXT" };
    const destination = action === "archiveClientAction" ? "/clients" : "/clients/client-A";
    await expect(actions[action](form)).rejects.toMatchObject({ message: "NEXT_REDIRECT", digest: expect.stringContaining(`;${destination};`) });
    expect(auditState.archivedAt === null).toBe(action === "unarchiveClientAction");
    expect(auditState.auditLogs).toHaveLength(1);
    expect(auditState.auditLogs[0]).toContain("audit_write_unavailable");
    expect(auditState.auditLogs[0]).not.toContain("PRIVATE");
  });
  it.each(["archiveClientAction", "unarchiveClientAction"] as const)("%s preserves rejection on a rejected audit promise without leaking text", async (action) => {
    const actions = await import("@/app/(app)/clients/[id]/actions");
    const form = new FormData(); form.set("client_id", "client-A");
    auditState.archivedAt = action === "unarchiveClientAction" ? "2026-10-20T00:00:00.000Z" : null;
    auditState.throwWrite = true;
    await expect(actions[action](form)).rejects.toMatchObject({ message: "Could not record the archive audit entry. Please try again." });
    // The pre-existing archive operation already committed; no rollback claim.
    expect(auditState.archivedAt === null).toBe(action === "unarchiveClientAction");
  });
  it("write errors/rejections remain curated; exports cannot report audit success", async () => {
    auditState.writeError = { message: "PRIVATE DATABASE TEXT" };
    expect((await recordStudioExportAudit(exportAuditInput())).error).not.toBeNull();
    expect(JSON.stringify(await recordClientArchiveAudit({ expectedStudioId: "studio-A", clientId: "client-A", change: "unarchive" }))).not.toContain("PRIVATE");
    auditState.writeError = null; auditState.throwWrite = true;
    expect((await recordStudioExportAudit(exportAuditInput())).error).not.toBeNull();
    await expect(recordClientArchiveAudit({ expectedStudioId: "studio-A", clientId: "client-A", change: "unarchive" })).rejects.toMatchObject({ message: "Could not record the archive audit entry. Please try again." });
    expect(auditState.inserted).toEqual([]);
  });
});
