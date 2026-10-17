import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// HON-46 — source contract for the per-client clinical-records export, so the
// exclusions and the ordering rules cannot be quietly regressed:
//   * the server reads never touch private warnings, personal notes, payment
//     or planning columns;
//   * the page refuses non-owners before reading the client, and audits before
//     loading records (through auditThenLoad);
//   * nothing is logged, and the printable title carries no client name.

const ROOT = path.resolve(__dirname, "../..");
const FILES = {
  queries: "lib/clinical-records/export-queries.ts",
  scope: "lib/clinical-records/export-scope.ts",
  page: "app/(app)/clients/[id]/records/export/page.tsx",
  action: "app/(app)/clients/[id]/records/export/actions.ts",
  button: "app/(app)/clients/[id]/records/export/print-button.tsx",
} as const;

/** Source with whole-line comments removed (block-comment lines start with *). */
function code(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8")
    .split("\n")
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join("\n");
}

describe("HON-46 export reads exclude private and payment data", () => {
  it("never names the personal-notes table, its columns, payment or planning fields", () => {
    for (const rel of [FILES.queries, FILES.page, FILES.action]) {
      const src = code(rel);
      for (const banned of [
        "client_personal_notes",
        "private_warnings",
        "personal_notes",
        "price_paid_cents",
        "payment_charge_attempts",
        "appointment_settlements",
        "next_session_note",
        "delete_reason",
      ]) {
        expect(src, `${rel} must not reference ${banned}`).not.toContain(banned);
      }
    }
  });

  it("selects named columns only (no select('*'))", () => {
    expect(code(FILES.queries)).not.toMatch(/\.select\(\s*["'`]\*["'`]\s*\)/);
  });

  it("filters out deleted sessions and entries", () => {
    expect(code(FILES.queries).match(/\.is\("deleted_at", null\)/g) ?? []).toHaveLength(2);
  });
});

describe("HON-46 authorization and audit ordering", () => {
  it("the page refuses non-owners before reading the client", () => {
    const src = code(FILES.page);
    const ownerGate = src.indexOf('practitioner.role !== "owner"');
    expect(ownerGate).toBeGreaterThan(-1);
    expect(ownerGate).toBeLessThan(src.indexOf("getClientById("));
  });

  it("the page loads records only through auditThenLoad, with the preview audit first", () => {
    const src = code(FILES.page);
    expect(src).toContain("auditThenLoad<");
    expect(src.indexOf('"clinical_records_previewed"')).toBeLessThan(src.indexOf("loadClinicalRecordsForExport("));
    expect(src.match(/loadClinicalRecordsForExport\(/g) ?? []).toHaveLength(1);
  });

  it("the print action re-derives owner, client and scope, and audits the print", () => {
    const src = code(FILES.action);
    expect(src).toContain('practitioner.role !== "owner"');
    expect(src).toContain("getClientById(");
    expect(src).toContain("parseExportScope(");
    expect(src).toContain('"clinical_records_printed"');
  });

  it("the button prints only after the audit succeeded", () => {
    expect(code(FILES.button)).toMatch(/if \(r\.ok\) window\.print\(\);/);
  });
});

describe("HON-46 leaks nothing to logs or file names (#828)", () => {
  it("no console output in any export file", () => {
    for (const rel of Object.values(FILES)) {
      expect(code(rel), rel).not.toMatch(/console\./);
    }
  });

  it("the printable title is fixed and carries no client name", () => {
    const src = code(FILES.page);
    expect(src).toContain('export const metadata: Metadata = { title: "Clinical records export" };');
    expect(src).not.toMatch(/generateMetadata/);
  });

  it("the page is dynamic, so it is never cached", () => {
    expect(code(FILES.page)).toContain('export const dynamic = "force-dynamic";');
  });
});
