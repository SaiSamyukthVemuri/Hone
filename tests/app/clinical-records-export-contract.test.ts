import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// HON-46 — source contract for the per-client clinical-records export, so the
// exclusions and the ordering rules cannot be quietly regressed:
//   * the server reads never touch private warnings, personal notes, payment
//     or planning columns, and they read the CURRENT charting fields;
//   * the page refuses non-owners before reading the client, and audits before
//     loading records (through auditThenLoad);
//   * the route lives outside every analytics-mounting layout, and nothing
//     soft-navigates into it;
//   * nothing is logged, and the printable title carries no client name.

const ROOT = path.resolve(__dirname, "../..");
const DIR = "app/(records-export)/clients/[id]/records/export";
const FILES = {
  queries: "lib/clinical-records/export-queries.ts",
  scope: "lib/clinical-records/export-scope.ts",
  layout: "app/(records-export)/layout.tsx",
  page: `${DIR}/page.tsx`,
  action: `${DIR}/actions.ts`,
  button: `${DIR}/print-button.tsx`,
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

  it("filters out deleted sessions, settings blocks and entries", () => {
    expect(code(FILES.queries).match(/\.is\("deleted_at", null\)/g) ?? []).toHaveLength(3);
  });

  it("reads the CURRENT charting fields as well as the legacy ones (Codex P1 4301165385)", () => {
    const src = code(FILES.queries);
    expect(src).toContain('.from("session_blocks")');
    for (const col of [
      "primary_area",
      "probe_label",
      "probe_lot_number",
      "numbing_status",
      "reaction_type",
      "block_id",
      "thermolysis_intensity_percent",
      "galvanic_ma",
      "pulse_delay_seconds",
      "observation_chips",
      "intensity",
      "duration_seconds",
    ]) {
      expect(src, col).toContain(col);
    }
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

describe("HON-46 is structurally outside third-party telemetry (Codex P1 4301165382, #828 G-26)", () => {
  it("the route is not under app/(app), whose layout mounts SafeAnalytics", () => {
    for (const rel of Object.values(FILES)) expect(rel.startsWith("app/(app)/")).toBe(false);
    expect(code("app/(app)/layout.tsx")).toContain("<SafeAnalytics />");
  });

  it("its layout mounts no analytics of any kind", () => {
    const src = code(FILES.layout);
    for (const banned of ["SafeAnalytics", "@vercel/analytics", "@vercel/speed-insights", "posthog", "identifyServerUser"]) {
      expect(src, banned).not.toContain(banned);
    }
  });

  it("the app root layout mounts no analytics either", () => {
    const src = code("app/layout.tsx");
    for (const banned of ["<SafeAnalytics", "@vercel/analytics", "@vercel/speed-insights"]) {
      expect(src, banned).not.toContain(banned);
    }
  });

  it("nothing soft-navigates into the export (no next/link to records/export)", () => {
    const files = execSync("git ls-files 'app/*.tsx' 'components/*.tsx' 'app/**/*.tsx' 'components/**/*.tsx'", {
      cwd: ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    const offenders = files.filter((f) => {
      const src = code(f);
      return /<Link\b[^>]*href=\{?[^>]*records\/export/.test(src) || /router\.push\([^)]*records\/export/.test(src);
    });
    expect(offenders).toEqual([]);
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
