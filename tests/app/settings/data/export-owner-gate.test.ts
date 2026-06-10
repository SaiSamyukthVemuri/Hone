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
