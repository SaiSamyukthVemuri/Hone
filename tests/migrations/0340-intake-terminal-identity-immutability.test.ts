import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0340: rollback file and application-writer census. Behaviour is proved against a real database in
// tests/db/intake-terminal-identity.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0340_intake_terminal_identity_immutability";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0340: rollback", () => {
  it("the down removes exactly the two triggers and the new function", () => {
    expect(DOWN).toContain("drop trigger if exists client_intake_forms_lineage_fixed on public.client_intake_forms;");
    expect(DOWN).toContain("drop trigger if exists client_intake_forms_terminal_visibility on public.client_intake_forms;");
    expect(DOWN).toContain("drop function if exists public.enforce_intake_terminal_visibility();");
    expect(DOWN).not.toContain("guard_immutable_clinical_lineage");
    expect(DOWN).not.toMatch(/\bcreate\b|alter table|\b(insert into|update public|delete from)\b/);
  });
});

describe("0340: no application path writes the pinned columns on an existing intake", () => {
  // If a later change adds such a writer on the user-scoped client, the guard will refuse it for terminal rows.
  it("no .update() on client_intake_forms sets client_id, studio_id or deleted_at", () => {
    const files = execSync(`grep -rlE 'from\\("client_intake_forms"\\)' app lib || true`, { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const src = readFileSync(join(root, f), "utf8");
      const updates = src.match(/from\("client_intake_forms"\)\s*\.update\(\{[\s\S]*?\}\)/g) ?? [];
      for (const u of updates) {
        expect(u, f).not.toMatch(/\b(client_id|studio_id|deleted_at)\s*[:,}]/);
      }
    }
  });
});
