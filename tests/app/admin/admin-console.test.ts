import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #255: Admin Console V1. Source-pins that NO client-level clinical data is
// read into the console. Access control (middleware, layout and page gates) is
// proven at request level by tests/security/sec-002-admin-route-requests.test.ts;
// the rendered surface by e2e/new-studio-wizard.spec.ts.

const ROOT = path.resolve(__dirname, "../../..");
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}
function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const PAGE = read("app/admin/page.tsx");
const PAGE_CODE = codeOnly(PAGE);

describe("data privacy: NO client-level clinical data in the console", () => {
  it("reads only aggregate counts + operational metadata (no client/clinical row reads)", () => {
    // Aggregate count embeds are allowed; selecting client/clinical ROWS is not.
    expect(PAGE_CODE).not.toMatch(/\.from\("clients"\)\s*\n?\s*\.select/);
    expect(PAGE_CODE).not.toMatch(
      /\.from\("(sessions|session_blocks|treatment_areas|intake_submissions)"\)/,
    );
    expect(PAGE_CODE).not.toMatch(
      /\.from\("(record_keeping_exposure_incidents|imported_treatment_memories|import_batches)"\)/,
    );
    expect(PAGE_CODE).not.toMatch(
      /\.from\("(appointment_payments|payment_charge_attempts|manual_fee_charge_attempts|stripe_events|studio_payment_settings)"\)/,
    );
  });

  it("selects no treatment / exposure / payment / token / audit content columns", () => {
    expect(PAGE_CODE).not.toMatch(
      /treatment_area_text|tolerance_text|reaction_text|caution_note|exposed_person|probe_lot/i,
    );
    expect(PAGE_CODE).not.toMatch(/stripe_|payment_intent|client_secret|livemode/i);
    // No audit/token CONTENT is selected here. A nav link to /admin/audit is fine —
    // the audit log lives on its own isAdmin-gated page, not the console home.
    expect(PAGE_CODE).not.toMatch(/\btoken\b|audit_event|\.from\("[^"]*audit/i);
  });
});
