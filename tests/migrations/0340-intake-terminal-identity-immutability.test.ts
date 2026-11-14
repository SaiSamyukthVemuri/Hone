import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0340: STATIC contract only. Behaviour is proved against a real database in
// tests/db/intake-terminal-identity.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0340_intake_terminal_identity_immutability";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0340: shape", () => {
  it("consumes exactly one number, opens its own transaction and arms lock_timeout inside it", () => {
    expect(countVersion("0340")).toBe(1);
    expect(E.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(E.trim().endsWith("commit;")).toBe(true);
  });

  it("adds one invoker trigger function and two triggers, and nothing else", () => {
    expect(E.match(/create (or replace )?function/g)?.length).toBe(1);
    expect(E.match(/create trigger/g)?.length).toBe(2);
    expect(E).toMatch(/security invoker\s+set search_path = ''/);
    expect(E).not.toMatch(/security definer|create policy|drop policy|alter table|\bgrant\b|\b(insert into|update public|delete from)\b/);
    // the function is not callable by any API role
    expect(E).toMatch(/revoke all on function public\.enforce_intake_terminal_visibility\(\) from public, anon, authenticated, service_role;/);
  });

  it("pins client_id and studio_id with the established 0160 guard, and deleted_at on terminal rows for JWT callers", () => {
    expect(E).toMatch(
      /create trigger client_intake_forms_immutable_lineage\s+before update of client_id, studio_id on public\.client_intake_forms\s+for each row execute function public\.guard_immutable_clinical_lineage\('client_id', 'studio_id'\);/,
    );
    expect(E).toContain("when (new.deleted_at is distinct from old.deleted_at)");
    expect(E).toContain("if auth.uid() is not null and old.status in ('submitted', 'reviewed') then");
    // the shared guard and the 0118/0162 guard are reused / left alone, never redefined
    expect(E).not.toMatch(/create (or replace )?function public\.guard_immutable_clinical_lineage/);
    expect(E).not.toMatch(/drop trigger if exists client_intake_forms_terminal_immutability/);
    expect(E).not.toMatch(/function public\.enforce_intake_terminal_immutability/);
  });

  it("the down removes exactly the two triggers and the new function", () => {
    expect(DOWN).toContain("drop trigger if exists client_intake_forms_immutable_lineage on public.client_intake_forms;");
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
