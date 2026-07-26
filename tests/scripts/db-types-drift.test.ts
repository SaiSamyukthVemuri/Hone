import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #221. Static pins (unit lane) for the generated-types drift
// check. The check itself runs in the db-integration lane against
// the local migrated database; these pins keep its wiring and
// safety properties from eroding, and pin that the recently added
// columns the check exists to protect are declared in the app types
// (so even the fast lane catches an accidental revert of the
// drift-fix declarations).

function read(rel: string): string {
  return readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
}

const SCRIPT = read("scripts/check-db-types.mjs");
const CI = read(".github/workflows/ci.yml");
const PKG = read("package.json");
const TYPES = read("lib/types/database.ts");

describe("drift check script exists and is wired", () => {
  it("npm script check:db-types runs the script", () => {
    expect(PKG).toMatch(/"check:db-types": "node scripts\/check-db-types\.mjs"/);
  });

  it("ci db-integration job runs the drift check after the DB tests", () => {
    const job = CI.slice(CI.indexOf("db-integration:"));
    expect(job).toMatch(/npm run test:db[\s\S]*npm run check:db-types/);
  });

  it("the fast lane does not gain a DB dependency", () => {
    const ciScript = JSON.parse(PKG).scripts.ci as string;
    expect(ciScript).not.toMatch(/check:db-types/);
  });
});

describe("drift check is local-only by construction", () => {
  it("generation is hardcoded to --local with no linked/ref/token path", () => {
    expect(SCRIPT).toMatch(
      /execFileSync\("supabase", \["gen", "types", "typescript", "--local"\]/,
    );
    // Scan executable lines only; the header comment legitimately
    // documents that --linked and project refs are NOT used.
    const executable = SCRIPT.split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(executable).not.toMatch(/--linked/);
    expect(executable).not.toMatch(/--project-id/);
    expect(executable).not.toMatch(/SUPABASE_ACCESS_TOKEN/);
  });

  it("refuses hosted or non-localhost env URLs", () => {
    expect(SCRIPT).toMatch(/supabase\\\.co\|supabase\\\.com/);
    expect(SCRIPT).toMatch(/is not localhost/);
    expect(SCRIPT).toMatch(/hosted-database host pattern/);
  });

  it("reads no production credentials", () => {
    expect(SCRIPT).not.toMatch(/process\.env\.SUPABASE_SERVICE_ROLE_KEY/);
    expect(SCRIPT).not.toMatch(/process\.env\.NEXT_PUBLIC_SUPABASE_URL/);
    expect(SCRIPT).not.toMatch(/process\.env\.STRIPE/);
    const envReads = SCRIPT.match(/process\.env\.[A-Z_]+/g) ?? [];
    expect([...new Set(envReads)].sort()).toEqual([]);
    // Env vars are consulted only via the guarded name list.
    expect(SCRIPT).toMatch(/\["SUPABASE_DB_URL", "HONE_LOCAL_DB_URL"\]/);
  });
});

describe("curated coverage", () => {
  const CURATED = [
    "studios",
    "practitioners",
    "clients",
    "appointments",
    "sessions",
    "session_blocks",
    "electrolysis_entries",
    "laser_entries",
    "client_intake_forms",
    "treatment_plans",
    "treatment_plan_stages",
    "record_keeping_sterile_items",
    "record_keeping_disinfectants",
    "record_keeping_exposure_incidents",
    "record_keeping_audit_events",
  ];

  it("every curated table (incl. Record Keeping) is exact-matched", () => {
    for (const table of CURATED) {
      expect(SCRIPT).toMatch(new RegExp(`^  ${table}: "`, "m"));
    }
  });

  it("payment and webhook tables are covered DB-side", () => {
    for (const table of [
      "payment_charge_attempts",
      "manual_fee_charge_attempts",
      "stripe_events",
      "ops_alerts",
    ]) {
      expect(SCRIPT).toMatch(new RegExp(`${table}: \\[`));
    }
    expect(SCRIPT).toMatch(/"stripe_livemode"/);
  });

  it("the recent critical columns are pinned in the script", () => {
    for (const col of [
      "default_machine_frequency",
      "calendar_feed_token_hash",
      "probe_lot_number",
      "probe_inventory_item_id",
      "numbing_notes",
      "probe_key",
      "tolerance_rating",
      "reaction_type",
      "reaction_notes",
      "caution_for_next_session",
      "caution_note",
      "aftercare_and_risks_explained_at",
      "aftercare_and_risks_explained_by",
      "next_session_note",
    ]) {
      expect(SCRIPT).toContain(`"${col}"`);
    }
  });
});

describe("app types declare the columns the drift check protects", () => {
  it("recent critical columns exist in lib/types/database.ts", () => {
    for (const col of [
      "default_machine_frequency",
      "probe_lot_number",
      "probe_inventory_item_id",
      "numbing_notes",
      "probe_key",
      "tolerance_rating",
      "reaction_type",
      "reaction_notes",
      "caution_for_next_session",
      "caution_note",
      "aftercare_and_risks_explained_at",
      "aftercare_and_risks_explained_by",
      "next_session_note",
    ]) {
      expect(TYPES).toMatch(new RegExp(`^  ${col}\\??:`, "m"));
    }
  });

  it("the PR #221 drift fixes stay declared", () => {
    // Found by the first run of the drift check: these live columns
    // were missing from the hand-rolled types.
    for (const col of [
      "calendar_feed_token_hash",
      "terms_accepted_at",
      "terms_version",
      "privacy_accepted_at",
      "privacy_version",
      "normalized_email",
    ]) {
      expect(TYPES).toMatch(new RegExp(`^  ${col}: string \\| null;`, "m"));
    }
  });
});
