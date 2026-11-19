import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

// Migration 0087 (clinical RLS delete hardening) is applied and frozen. What
// can still change is everything around it: a later migration re-creating a
// broad policy, or app code hard-deleting a table 0087 made no-delete.

function read(rel: string): string {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

// The full migration chain, used to prove no file after 0087 re-creates a
// broad policy on the hardened tables.
const CHAIN = readdirSync(join(process.cwd(), "supabase/migrations"))
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ f, src: read(`supabase/migrations/${f}`) }));

const NO_DELETE_TABLES = [
  "clients",
  "sessions",
  "session_blocks",
  "photos",
  "probe_lots",
  "client_intake_forms",
  "client_tags",
  "treatment_goals",
  "client_personal_notes",
];
// NOTE: this list asserts what migration 0087 *itself* kept. electrolysis_entries
// and laser_entries were later HARDENED by migration 0115 (their delete policy
// dropped + grant revoked) once passes became soft-delete-only (0114/PR #391),
// so in the FINAL DB state those two are NOT member-deletable. The final posture
// is proven in tests/db/clinical-delete-posture.db.test.ts + the 0115 test.
const DELETE_KEPT_TABLES = [
  "electrolysis_entries",
  "laser_entries",
  "treatment_plan_stages",
  "client_pricing",
];

describe("chain invariants after 0087", () => {
  it("no migration AFTER 0087 re-creates a FOR ALL policy on the hardened tables", () => {
    const after = CHAIN.filter(({ f }) => f > "0087");
    for (const { f, src } of after) {
      for (const t of [...NO_DELETE_TABLES, ...DELETE_KEPT_TABLES]) {
        expect(src, `${f} -> ${t}`).not.toMatch(
          new RegExp(`on public\\.${t}[\\s\\S]{0,40}for all`),
        );
      }
    }
  });
});

describe("app compatibility", () => {
  it("no app code hard-deletes the no-delete tables", () => {
    // Each from("<table>") call followed by .delete() within a few
    // lines would break under the new policies; prove none exist.
    for (const t of NO_DELETE_TABLES) {
      const out = execSync(
        `grep -rn 'from("${t}")' app lib --include='*.ts' --include='*.tsx' | grep -v test || true`,
        { cwd: process.cwd() },
      ).toString();
      for (const line of out.split("\n").filter(Boolean)) {
        const [file, lineNo] = line.split(":");
        const src = read(file);
        const idx = src.split("\n").slice(Number(lineNo) - 1, Number(lineNo) + 6).join("\n");
        expect(idx, `${file}:${lineNo}`).not.toMatch(/\.delete\(\)/);
      }
    }
  });

  // L18 Phase 2 STRENGTHENED this case. The block-creation cleanup used to be a
  // compensating soft delete, run by the application after the entry write
  // failed but the block had already committed. `create_block_with_entry`
  // (migration 0166) now owns both writes in one transaction, so there is
  // nothing left to compensate for and the cleanup is gone entirely. What 0087
  // actually protects — no hard DELETE of a clinical block, ever — is asserted
  // more strongly than before: not "the cleanup uses update", but "no runtime
  // code issues row DML against session_blocks at all".
  it("the block-creation cleanup is gone: the write is atomic, and nothing hard-deletes a block", () => {
    const src = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/block-actions.ts",
    );
    expect(src).not.toMatch(/from\("session_blocks"\)\s*\n?\s*\.delete\(\)/);
    // No compensating cleanup remains, because the failure it compensated for
    // can no longer produce a committed block.
    expect(src).not.toMatch(/Cleanup: retire the just-created block/);
    expect(src).toMatch(/create_block_with_entry/);
  });

  it("the plan-creation rollback closes the plan (the old delete was a silent no-op)", () => {
    const src = read("app/(app)/clients/[id]/treatment-plans-actions.ts");
    expect(src).toMatch(
      /from\("treatment_plans"\)\s*\n\s*\.update\(\{ status: "closed" \}\)/,
    );
    expect(src).not.toMatch(/from\("treatment_plans"\)\.delete\(\)/);
  });

  it("the preserved delete affordances still exist (entries, stages, pricing)", () => {
    const sessionActions = read(
      "app/(app)/clients/[id]/sessions/[sessionId]/actions.ts",
    );
    expect(sessionActions).toMatch(/deleteElectrolysisEntryAction/);
    expect(sessionActions).toMatch(/deleteLaserEntryAction/);
    expect(read("app/(app)/clients/[id]/treatment-plans-actions.ts")).toMatch(
      /deleteTreatmentPlanStageAction/,
    );
    expect(read("app/(app)/clients/[id]/actions.ts")).toMatch(
      /deleteClientPricingAction/,
    );
  });
});
