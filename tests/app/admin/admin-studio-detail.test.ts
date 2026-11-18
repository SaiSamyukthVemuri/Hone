import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #256: admin studio-detail privacy follow-up. Pins that the operator-only
// /admin/studios/[id] page selects no raw client names/contacts and no clinical /
// payment / token / audit content. End-to-end (no seeded client name appears)
// is proven by e2e/new-studio-wizard.spec.ts; the access gate by
// tests/security/sec-002-admin-route-requests.test.ts.

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

const PAGE = read("app/admin/studios/[id]/page.tsx");
const PAGE_CODE = codeOnly(PAGE);

describe("privacy: no raw client data is selected or rendered", () => {
  it("does NOT run a standalone clients / practitioners / invitations ROW select", () => {
    // Clients/appointments/imported-memory appear ONLY as embedded (count)
    // aggregates inside the studios select, never as row queries.
    expect(PAGE_CODE).not.toMatch(/\.from\("clients"\)/);
    expect(PAGE_CODE).not.toMatch(/\.from\("practitioners"\)/);
    expect(PAGE_CODE).not.toMatch(/\.from\("imported_treatment_memories"\)/);
    expect(PAGE_CODE).not.toMatch(/\.from\("appointments"\)/);
  });

  it("does NOT render a client name (the removed leak)", () => {
    expect(PAGE_CODE).not.toMatch(/clients\.map/);
    expect(PAGE_CODE).not.toMatch(/\{c\.name\}/);
    // The old leaky select shape must be gone.
    expect(PAGE_CODE).not.toMatch(/"id, name, created_at"/);
    expect(PAGE_CODE).not.toMatch(/\.from\("studios"\)\s*\n?\s*\.select\("\*"\)/);
  });

  it("selects NO clinical / token / audit content columns; payment data is capability-only + redacted", () => {
    expect(PAGE_CODE).not.toMatch(
      /treatment_area_text|tolerance_text|reaction_text|caution_note|exposed_person|probe_lot/i,
    );
    // PR B consciously allows payment CAPABILITY display on this page via
    // the redaction-first helper. The page itself still never touches raw
    // payment identifiers or Stripe columns:
    expect(PAGE_CODE).not.toMatch(/payment_intent|client_secret|stripe_account_id|stripe_customer|fingerprint/i);
    expect(PAGE_CODE).not.toMatch(/\.from\("(studio_payment_settings|client_payment_methods|payment_charge_attempts)"\)/);
    expect(PAGE_CODE).toMatch(/loadStudioPaymentStatus/); // reads go through the helper
    expect(PAGE_CODE).toMatch(/accountIdRedacted/);       // redacted suffix only
    expect(PAGE_CODE).not.toMatch(/token|audit_event/i);
    // No client contact columns.
    expect(PAGE_CODE).not.toMatch(/phone|\baddress\b/i);
  });
});
