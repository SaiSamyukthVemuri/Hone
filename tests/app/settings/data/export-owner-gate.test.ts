import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
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
    expect(CODE).toMatch(
      /\.from\("audit_logs"\)\.insert\(\{\s*\n?\s*studio_id: studio\.id,\s*\n?\s*actor_id: practitioner\.id,\s*\n?\s*action: "studio_export",/,
    );
  });

  it("the audit row carries entity + metadata (filename, files, row counts)", () => {
    expect(CODE).toMatch(/entity_type: "studio",/);
    expect(CODE).toMatch(/entity_id: studio\.id,/);
    expect(CODE).toMatch(/filename,/);
    expect(CODE).toMatch(/row_counts: \{/);
    expect(CODE).toMatch(/clients: \(clientsRes\.data \?\? \[\]\)\.length,/);
  });

  it("audit insert happens after the zip is built and before the success return", () => {
    const zipIdx = CODE.indexOf("zip.generateAsync");
    const auditIdx = CODE.indexOf('action: "studio_export"');
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
      CODE.indexOf('.from("audit_logs")'),
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

  it("still uses the user-scoped client (RLS enforced), not the admin client", () => {
    expect(ACTIONS).toMatch(/from "@\/lib\/supabase\/server"/);
    expect(ACTIONS).not.toMatch(/admin-server/);
  });
});

describe("PR #312: record-keeping / inspection CSVs", () => {
  it("the ZIP includes all four record-keeping CSVs", () => {
    expect(CODE).toMatch(/zip\.file\(\s*\n?\s*"record_keeping_sterile_items\.csv"/);
    expect(CODE).toMatch(/zip\.file\(\s*\n?\s*"record_keeping_disinfectants\.csv"/);
    expect(CODE).toMatch(/zip\.file\(\s*\n?\s*"record_keeping_exposure_incidents\.csv"/);
    expect(CODE).toMatch(/zip\.file\(\s*\n?\s*"record_keeping_audit_events\.csv"/);
  });

  // Migration 0182: the discard lifecycle must reach the inspection export.
  it("the sterile-items export SELECTS and EMITS date_discarded, and filters nothing", () => {
    // Scoped to the sterile load + its CSV writer. The export uses an EXPLICIT
    // column list in both places, so a new column reaches the inspector only if
    // it is named twice — this pin is the reason that cannot be half-done.
    const from = CODE.indexOf('.from("record_keeping_sterile_items")');
    expect(from).toBeGreaterThan(-1);
    const load = CODE.slice(from, from + 500);
    expect(load).toMatch(/date_discarded/);
    // HISTORICAL surface: a discarded row must still be exported. A lifecycle
    // predicate here would silently drop stock from a health-inspection record.
    expect(load).not.toMatch(/\.is\("date_discarded"/);
    expect(load).not.toMatch(/\.not\("date_discarded"/);

    const writer = CODE.indexOf('"record_keeping_sterile_items.csv"');
    expect(writer).toBeGreaterThan(-1);
    const header = CODE.slice(writer, writer + 700);
    expect(header).toMatch(/"date_discarded"/);
    expect(header).toMatch(/"expiry_date"/);
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
      const slice = CODE.slice(from, from + 400);
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
      CODE.indexOf('.from("record_keeping_audit_events")'),
      CODE.indexOf('.from("record_keeping_audit_events")') + 400,
    );
    expect(load).toMatch(/changed_fields/);
    expect(load).not.toMatch(/\bchanges\b/);
    expect(load).not.toMatch(/\bmetadata\b/);
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
    expect(ACTIONS).toMatch(/record_keeping_sterile_items\.csv:/);
    expect(ACTIONS).toMatch(/record_keeping_exposure_incidents\.csv:.*OWNER-ONLY/);
  });

  it("no migration/schema/RLS change ships from the action (source is read-only)", () => {
    expect(CODE).not.toMatch(/alter table|create policy|drop policy|create table|\.rpc\(/i);
  });
});
