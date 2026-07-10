import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0118: a BEFORE UPDATE trigger makes submitted/reviewed intake
// answers immutable to authenticated end-users (service-role exempt), closing a
// same-tenant clinical-record integrity defect. Carries the repo-max tripwire
// (moved here from 0117). Behavioral proof lives in
// tests/db/intake-terminal-immutability.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0118_intake_terminal_immutability.sql";
const SQL = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const SQL_CODE = SQL.replace(/--.*$/gm, "");

describe("0118 — number (repo-max tripwire)", () => {
  it("is the repo migration max", () => {
    const maxNum = Math.max(
      ...readdirSync(MIGRATIONS_DIR)
        .map((f) => /^(\d{4})_.*\.sql$/.exec(f))
        .filter(Boolean)
        .map((m) => Number((m as RegExpExecArray)[1])),
    );
    expect(maxNum).toBe(118);
    expect(FILE).toMatch(/^0118_/);
  });
});

describe("0118 — intake terminal-state immutability trigger", () => {
  it("creates a BEFORE UPDATE trigger on client_intake_forms", () => {
    expect(SQL_CODE).toMatch(
      /create trigger client_intake_forms_terminal_immutability\s+before update on public\.client_intake_forms/,
    );
    expect(SQL_CODE).toMatch(
      /execute function public\.enforce_intake_terminal_immutability\(\)/,
    );
  });

  it("exempts service-role (auth.uid() is null) — targets authenticated end-users", () => {
    expect(SQL_CODE).toMatch(/if auth\.uid\(\) is null then\s+return new;/);
  });

  it("makes answers + submitted_at immutable and blocks status regression on terminal rows", () => {
    expect(SQL_CODE).toMatch(/old\.status in \('submitted', 'reviewed'\)/);
    expect(SQL_CODE).toMatch(/new\.responses is distinct from old\.responses/);
    expect(SQL_CODE).toMatch(/new\.submitted_at is distinct from old\.submitted_at/);
    expect(SQL_CODE).toMatch(/new\.status = 'in_progress'/);
  });

  it("binds reviewed_by to the caller and freezes review attribution once reviewed", () => {
    expect(SQL_CODE).toMatch(
      /new\.reviewed_by not in \(\s*select id from public\.practitioners\s+where user_id = auth\.uid\(\) and active = true/,
    );
    expect(SQL_CODE).toMatch(
      /old\.status = 'reviewed'[\s\S]*new\.reviewed_at is distinct from old\.reviewed_at/,
    );
  });

  it("is a trigger-only migration — no schema/policy/grant/data change", () => {
    expect(SQL_CODE).not.toMatch(/alter table/i);
    expect(SQL_CODE).not.toMatch(/add column|drop column/i);
    expect(SQL_CODE).not.toMatch(/create policy|drop policy/i);
    expect(SQL_CODE).not.toMatch(/\bgrant\b|\brevoke\b/i);
    expect(SQL_CODE).not.toMatch(/^\s*update\s/im);
    expect(SQL_CODE).not.toMatch(/^\s*delete\s+from/im);
    expect(SQL_CODE).not.toMatch(/^\s*insert\s+into/im);
    // search_path hardened; SECURITY INVOKER (not DEFINER).
    expect(SQL_CODE).toMatch(/set search_path = ''/);
    expect(SQL_CODE).toMatch(/security invoker/);
  });
});
