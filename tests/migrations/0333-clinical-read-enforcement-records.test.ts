import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0333 (I1) source contract. The behaviour is proved against a database in tests/db/clin-read-enforcement-records.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0333")}`, "utf8");
const code = () => sql().replace(/--[^\n]*/g, "");

describe("0333 clinical-read enforcement, treatment records (source)", () => {
  it("exists exactly once and is the current repo maximum", () => {
    expect(countVersion("0333")).toBe(1);
    expect(isRepoMax("0333")).toBe(true);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code();
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });
  it("the helper is SECURITY DEFINER, stable, search_path empty, revoked from public/anon/authenticated/service_role by name and granted to authenticated only", () => {
    const c = code();
    expect(c).toMatch(/create or replace function public\.clin_key_studios\(p_key text\)[\s\S]*?security definer[\s\S]*?set search_path = ''/);
    expect(c).toMatch(/revoke all on function public\.clin_key_studios\(text\) from public, anon, authenticated, service_role;/);
    expect(c).toMatch(/grant execute on function public\.clin_key_studios\(text\) to authenticated;/);
    expect(c).not.toMatch(/grant execute on function public\.clin_key_studios\(text\) to (anon|service_role|public)/);
  });
  it("every changed policy is `to authenticated` and none keeps a membership-only branch", () => {
    const stmts = code().split(";").filter((s) => /alter policy/.test(s));
    expect(stmts.length).toBe(16);
    for (const s of stmts) {
      expect(s, s).toMatch(/\bto authenticated\b/);
      expect(s, s).not.toMatch(/is_studio_member|session_is_visible/);
      expect(s, s).toMatch(/clin_key_studios|from public\.sessions s/);
    }
  });
  it("record tables use clin.view_records and photo tables use clin.view_photos (own keys, not crossed)", () => {
    const stmts = code().split(";").filter((s) => /alter policy/.test(s));
    for (const s of stmts) {
      const table = /on public\.(\w+)/.exec(s)![1];
      if (table === "treatment_images" || table === "photos") {
        expect(s).toContain("clin.view_photos");
        expect(s).not.toContain("clin.view_records");
      } else if (/clin_key_studios/.test(s)) {
        expect(s, table).toContain("clin.view_records");
        expect(s, table).not.toContain("clin.view_photos");
      }
    }
  });
  it("changes no insert/update/delete policy, no table grant and no write path", () => {
    const c = code();
    expect(c).not.toMatch(/\bfor (insert|update|delete)\b/i);
    expect(c).not.toMatch(/\b(grant|revoke)\b[^;]*\bon (table )?public\./i);
    expect(c).not.toMatch(/drop policy|disable row level security|force row level security/i);
  });
  it("marks the proposed defaults for Sam", () => {
    expect(sql()).toMatch(/PROPOSED DEFAULTS, SAM TO CONFIRM/);
  });
});
