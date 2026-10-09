import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// THE SMS ACTIVATION RUNBOOK STATES EVERY SMS MIGRATION'S ORDER
// (Codex P1 4235048959, #819)
// ===========================================================================
//
// docs/runbooks/sms-p0-activation.md §0 said SMS-01 needed "No migration" after
// SMS-01 had gained 0208, which its public signup calls. An operator following
// it could deploy first and break every durable waitlist join. The cause was
// release facts restated across the runbook and updated piecemeal; the earlier
// same-family finding was #812's 4225678601.
//
// This pins the order table to the repository instead of to a sentence:
// - every SMS migration file is named in §0, so a new one fails here until §0
//   carries its gate;
// - SMS-01's row is migration-first on 0208, never "No migration";
// - §1b applies and verifies 0208 before the merge and deploy;
// - the header no longer claims nothing has been done.

const ROOT = path.resolve(__dirname, "../..");
const RUNBOOK = readFileSync(path.join(ROOT, "docs/runbooks/sms-p0-activation.md"), "utf8");

function section(heading: RegExp): string {
  const start = RUNBOOK.search(heading);
  expect(start, `missing section ${heading}`).toBeGreaterThan(-1);
  const rest = RUNBOOK.slice(start + 1);
  const next = rest.search(/\n## /);
  return next === -1 ? RUNBOOK.slice(start) : RUNBOOK.slice(start, start + 1 + next);
}

// Read lazily, inside each test, so a missing section fails that test with its
// own message rather than the whole file at collection.
const ORDER = () => section(/^## 0\. Order/m);
const SMS01_ROW = () => ORDER().split("\n").find((line) => line.includes("SMS-01")) ?? "";
const APPLY = () => section(/^## 1b\. Apply and verify `0208`/m);

describe("§0 names every SMS migration with its gate", () => {
  it("every SMS migration in the repository appears in the order table", () => {
    const smsMigrations = readdirSync(path.join(ROOT, "supabase/migrations"))
      .filter((name) => /sms/i.test(name) && /^\d{4}_/.test(name))
      .map((name) => name.slice(0, 4))
      .filter((version) => Number(version) >= 206); // the SMS P0 program starts at 0206
    expect(smsMigrations).toEqual(expect.arrayContaining(["0206", "0207", "0208"]));
    for (const version of smsMigrations) {
      expect(ORDER(), `§0 does not name ${version}`).toContain(`\`${version}\``);
    }
  });

  it("SMS-01's row is migration-first on 0208, never 'No migration'", () => {
    const row = SMS01_ROW();
    expect(row).toContain("`0208`");
    expect(row).toMatch(/Migration first: apply and verify `0208`/);
    expect(row).toMatch(/then merge and deploy/);
    expect(row).not.toMatch(/No migration/i);
  });

  it("migration pending-ness defers to the derived state, not to a sentence", () => {
    expect(ORDER()).toMatch(/DERIVED, never restated/);
    expect(ORDER()).toContain("npm run migration:state");
  });
});

describe("§1b applies and verifies 0208 before the merge", () => {
  it("is ordered before the SMS-01 merge and deploy", () => {
    expect(APPLY()).toMatch(/BEFORE the SMS-01 merge and deploy/);
  });

  it("lists and dry-runs first, applies once, and verifies both commands read-only", () => {
    expect(APPLY()).toContain("supabase migration list --linked");
    expect(APPLY()).toContain("supabase db push --linked --dry-run");
    expect(APPLY()).toMatch(/supabase db push --linked --yes`, with no `--include-all`/);
    expect(APPLY()).toContain("join_new_client_waitlist_with_sms_answer");
    expect(APPLY()).toContain("record_waitlist_sms_consent_by_practitioner");
    expect(APPLY()).toContain("alhhybgqdmcdyzpybykj");
  });
});

describe("the header states what is done", () => {
  it("no longer claims nothing has been done", () => {
    expect(RUNBOOK).not.toMatch(/NOTHING BELOW HAS BEEN DONE/);
    expect(RUNBOOK).toMatch(/\*\*Done:\*\*/);
    expect(RUNBOOK).toMatch(/\*\*Pending:\*\*/);
  });
});
