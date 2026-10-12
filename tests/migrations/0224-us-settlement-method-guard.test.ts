import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0224 — PAY-CCY-07 (#824, option B): a US studio does not record
// Interac e-Transfer. SOURCE CONTRACT.
//
// Behaviour is proved against a real database in
// tests/db/us-settlement-method-guard.db.test.ts. This file pins what that
// cannot see: the file wraps itself, it only ADDS a guard (no vocabulary,
// CHECK, row or other table is touched), the trigger function holds no grant,
// and 0214, which it reads, is byte-identical.
// ===========================================================================

const VERSION = "0224";
const FILE = "0224_us_settlement_method_guard.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read(FILE);
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const FN = "appointment_settlements_method_for_jurisdiction";

describe("0224 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this (CLAUDE.md §2).
    expect(isRepoMax(VERSION), "0224 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("reads 0214, which stays byte-identical", () => {
    expect(sha256(read("0214_studio_payment_jurisdiction.sql"))).toBe(
      "25da63b7bdacefa44e12c2357c85cb8b814cd7be4d25dfb8dbf8cf151e1ab65f",
    );
  });
});

describe("0224 wraps itself", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const begin = TOP_LEVEL.search(/\bbegin\s*;/i);
    const lock = TOP_LEVEL.search(/set\s+local\s+lock_timeout/i);
    const commit = TOP_LEVEL.search(/\bcommit\s*;/i);
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(commit).toBeGreaterThan(lock);
  });
});

describe("0224 only adds a guard", () => {
  it("defines exactly one function and one BEFORE INSERT trigger on appointment_settlements", () => {
    expect(TOP_LEVEL.match(/create\s+or\s+replace\s+function/gi) ?? []).toHaveLength(1);
    expect(TOP_LEVEL).toMatch(new RegExp(`create or replace function public\\.${FN}\\(\\)`));
    expect(TOP_LEVEL.match(/create\s+trigger/gi) ?? []).toHaveLength(1);
    expect(TOP_LEVEL).toMatch(
      new RegExp(
        `create trigger ${FN}\\s+before insert on public\\.appointment_settlements\\s+for each row execute function public\\.${FN}\\(\\)`,
      ),
    );
  });

  it("changes no table, CHECK, vocabulary or row", () => {
    expect(TOP_LEVEL).not.toMatch(/\balter\s+table\b/i);
    expect(TOP_LEVEL).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from|truncate)\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bconstraint\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bdrop\s+(table|function|type|constraint)\b/i);
  });

  it("refuses ONLY paid_e_transfer, and only for a US jurisdiction", () => {
    const body = CODE.slice(CODE.indexOf("as $$"), CODE.lastIndexOf("$$;"));
    expect(body).toMatch(/if new\.method is distinct from 'paid_e_transfer' then\s+return new;/);
    expect(body).toMatch(/if v_country = 'US' then\s+raise exception\s+'settlement_method_unavailable:/);
    // Serializes with set_studio_payment_jurisdiction (FOR UPDATE).
    expect(body).toMatch(/from public\.studio_payment_jurisdictions j[\s\S]*?for share;/);
    // No other method is named in the guard.
    for (const m of ["paid_cash", "paid_other_external", "waived", "still_owes"]) {
      expect(body).not.toContain(`'${m}'`);
    }
  });

  it("the trigger function pins its search_path and holds no grant", () => {
    expect(CODE).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
    expect(TOP_LEVEL).toMatch(
      new RegExp(
        `revoke all privileges on function public\\.${FN}\\(\\)\\s+from public, anon, authenticated, service_role;`,
      ),
    );
    expect(TOP_LEVEL).not.toMatch(/\bgrant\b/i);
  });
});
