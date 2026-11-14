import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0347 source contract. The behaviour is proved against a database in tests/db/record-lineage-fixed-0347.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0347")}`, "utf8");
const down = () => readFileSync(`supabase/rollbacks/${fileForVersion("0347").replace(/\.sql$/, ".down.sql")}`, "utf8");
const code = (t: string) => t.replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();

// trigger -> [table, columns, guard function]
const EXPECTED: Record<string, [string, string, string]> = {
  client_personal_notes_lineage_fixed: ["client_personal_notes", "client_id, studio_id", "guard_immutable_clinical_lineage('client_id', 'studio_id')"],
  treatment_goals_lineage_fixed: ["treatment_goals", "client_id, studio_id", "guard_immutable_clinical_lineage('client_id', 'studio_id')"],
  client_tags_lineage_fixed: ["client_tags", "client_id, studio_id", "guard_immutable_clinical_lineage('client_id', 'studio_id')"],
  photos_lineage_fixed: ["photos", "client_id, studio_id", "guard_immutable_clinical_lineage('client_id', 'studio_id')"],
  photos_session_lineage_clearable: ["photos", "session_id", "guard_clearable_clinical_lineage('session_id')"],
};

describe("0347 a record keeps the client and studio it was created for (source)", () => {
  it("exists exactly once and is the current repo maximum", () => {
    expect(countVersion("0347")).toBe(1);
    expect(isRepoMax("0347")).toBe(true);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code(sql());
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });

  it("creates exactly the five expected triggers, each preceded by its own drop-if-exists, with the exact columns and guard", () => {
    const c = norm(code(sql()));
    expect((c.match(/create trigger/g) ?? []).length).toBe(5);
    for (const [name, [table, cols, fn]] of Object.entries(EXPECTED)) {
      expect(c, name).toContain(`drop trigger if exists ${name} on public.${table}; create trigger ${name} before update of ${cols} on public.${table} for each row execute function public.${fn};`);
    }
  });

  it("uses the 0340 naming for the fixed guards and the 0160 guard functions that already exist", () => {
    const o = readFileSync(`supabase/migrations/${fileForVersion("0160")}`, "utf8");
    expect(o).toMatch(/create or replace function public\.guard_immutable_clinical_lineage\(\)/);
    expect(o).toMatch(/create or replace function public\.guard_clearable_clinical_lineage\(\)/);
    for (const name of Object.keys(EXPECTED)) expect(name).toMatch(/_lineage_(fixed|clearable)$/);
  });

  it("the session link on photos is the ONLY clearable one; every client/studio guard is immutable", () => {
    const c = norm(code(sql()));
    expect((c.match(/guard_clearable_clinical_lineage\(/g) ?? []).length).toBe(1);
    expect(c).toContain("before update of session_id on public.photos for each row execute function public.guard_clearable_clinical_lineage('session_id')");
    expect((c.match(/guard_immutable_clinical_lineage\('client_id', 'studio_id'\)/g) ?? []).length).toBe(4);
  });

  it("carries a guard block that fails the migration on a missing, disabled or wrongly-scoped trigger", () => {
    const c = norm(code(sql()));
    expect(c).toMatch(/t\.tgenabled = 'O' and not t\.tgisinternal/);
    expect(c).toMatch(/\(t\.tgtype & 19\) = 19/);
    expect(c).toMatch(/t\.tgfoid = v_expect\.fn::regproc/);
    expect(c).toMatch(/raise exception '0347: trigger % on % is missing, disabled, or guards the wrong columns'/);
    for (const name of Object.keys(EXPECTED)) expect(c).toContain(`'${name}'`);
  });

  it("is trigger-only: no function, policy, grant, table or column change, and no data statement", () => {
    const c = code(sql());
    expect(c).not.toMatch(/create (or replace )?function|create policy|alter policy|drop policy|alter table|create table|add column|drop column|create index/i);
    expect(c).not.toMatch(/(^|;)\s*(grant|revoke)\s/im);
    expect(c).not.toMatch(/^\s*(update|delete\s+from|insert\s+into|truncate)\s/im);
    expect(c).not.toMatch(/\bsecurity definer\b/i);
  });

  it("states the rule, the unchanged parts and the merge procedure note in its header", () => {
    expect(sql()).toMatch(/a record keeps the client and studio it was created for/i);
    expect(sql()).toMatch(/UNCHANGED ON PURPOSE/);
    expect(sql()).toMatch(/recorded, owner-authorized procedure/);
    expect(sql()).toMatch(/NOT APPLIED/);
  });

  it("has a rollback that drops exactly the five triggers and nothing else", () => {
    const d = norm(code(down()));
    expect((d.match(/drop trigger/g) ?? []).length).toBe(5);
    for (const [name, [table]] of Object.entries(EXPECTED)) expect(d).toContain(`drop trigger if exists ${name} on public.${table};`);
    expect(d).not.toMatch(/create|drop function|drop table|grant|revoke/i);
    expect(d.endsWith("commit;")).toBe(true);
    expect(d).toMatch(/set local lock_timeout/);
  });
});
