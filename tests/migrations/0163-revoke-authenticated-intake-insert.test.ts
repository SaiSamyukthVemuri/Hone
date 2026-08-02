import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0163 — remove the `authenticated` INSERT capability on
// client_intake_forms, closing the residual 0162 explicitly did NOT close:
// 0162's guard is a BEFORE UPDATE trigger, so a member could skip the
// transition entirely and INSERT a row already `status='reviewed'`.
//
// This file carries the REPO migration-max pin (it moved off the 0162 test when
// 0163 landed, exactly as it moved 0161 -> 0162 before that). 0163 is NOT
// applied, so unlike 0159/0160/0161/0162 it is deliberately NOT
// checksum-frozen — it may still be revised until it is applied.
//
// Behavioural proof lives in tests/db/intake-insert-boundary.db.test.ts, which
// runs against a real migrated database.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0163_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
// PROSE view: comment markers stripped so a rationale sentence that wraps
// across lines still reads as one sentence.
const PROSE = SQL.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
// CODE view: comments removed entirely, so a rationale that NAMES a forbidden
// construct cannot be mistaken for the construct itself.
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const FLAT_CODE = CODE.replace(/\s+/g, " ");

describe("0163 — intake INSERT boundary (repo migration-max tripwire)", () => {
  it("is present, 0162 precedes it, exactly one 0163, and it is the repo max", () => {
    expect(FILE).toMatch(/^0163_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0162_"))).toBe(true);
    expect(files.filter((f) => /^0163_/.test(f))).toHaveLength(1);
    // Nothing beyond 0163 may exist.
    expect(files.filter((f) => /^01(6[5-9]|[7-9]\d)_/.test(f))).toEqual([]);
    expect(files.filter((f) => /^0[2-9]\d\d_/.test(f))).toEqual([]);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(164);
    expect(new Set(nums).size).toBe(nums.length);
    // 0158 stays permanently skipped.
    expect(files.filter((f) => /^0158_/.test(f))).toEqual([]);
  });

  it("declares its migration-max transition", () => {
    expect(PROSE).toMatch(/Migration max 0162 -> 0163/i);
  });
});

describe("0163 — transactional with an armed lock_timeout", () => {
  it("opens its own transaction and commits exactly once", () => {
    expect(FLAT_CODE).toMatch(/\bbegin\s*;/i);
    expect(FLAT_CODE).toMatch(/\bcommit\s*;/i);
    expect(CODE.match(/^\s*begin\s*;/gim) ?? []).toHaveLength(1);
    expect(CODE.match(/^\s*commit\s*;/gim) ?? []).toHaveLength(1);
  });

  it("arms lock_timeout INSIDE the transaction", () => {
    expect(FLAT_CODE).toMatch(/set local lock_timeout\s*=\s*'5s'/i);
    const beginIdx = FLAT_CODE.search(/\bbegin\s*;/i);
    const lockIdx = FLAT_CODE.search(/set local lock_timeout/i);
    const commitIdx = FLAT_CODE.search(/\bcommit\s*;/i);
    expect(beginIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeGreaterThan(beginIdx);
    expect(commitIdx).toBeGreaterThan(lockIdx);
  });

  it("explains WHY it opens its own transaction (the 25P01 lesson)", () => {
    expect(PROSE).toMatch(/does NOT wrap a migration file in an explicit transaction/i);
    expect(PROSE).toMatch(/25P01/);
    expect(PROSE).toMatch(/55P03/);
  });
});

describe("0163 — removes the INSERT capability on both halves", () => {
  it("drops the dedicated member INSERT policy", () => {
    expect(FLAT_CODE).toMatch(
      /drop policy if exists client_intake_forms_member_insert on public\.client_intake_forms/i,
    );
  });

  it("defensively drops any legacy BROAD (FOR ALL) policy", () => {
    // A FOR ALL policy would silently re-grant INSERT after the dedicated
    // INSERT policy is gone, because FOR ALL covers every command.
    const drops = FLAT_CODE.match(/drop policy if exists client_intake_forms_\w+ on/gi) ?? [];
    expect(drops.length).toBeGreaterThanOrEqual(2);
    expect(PROSE).toMatch(/FOR ALL/i);
  });

  it("revokes INSERT from authenticated AND from anon, by role name", () => {
    expect(FLAT_CODE).toMatch(
      /revoke insert on public\.client_intake_forms from authenticated/i,
    );
    expect(FLAT_CODE).toMatch(/revoke insert on public\.client_intake_forms from anon/i);
  });

  it("carries the 0129/0130 lesson about revoking from anon explicitly", () => {
    expect(PROSE).toMatch(/anon/i);
    expect(PROSE).toMatch(/ALTER DEFAULT PRIVILEGES/i);
  });
});

describe("0163 — preserves everything it must not touch", () => {
  it("does NOT drop or alter the SELECT or UPDATE policies", () => {
    expect(FLAT_CODE).not.toMatch(/drop policy[^;]*client_intake_forms_member_select/i);
    expect(FLAT_CODE).not.toMatch(/drop policy[^;]*client_intake_forms_member_update/i);
    expect(FLAT_CODE).not.toMatch(/revoke\s+select\s+on public\.client_intake_forms/i);
    expect(FLAT_CODE).not.toMatch(/revoke\s+update\s+on public\.client_intake_forms/i);
  });

  it("does NOT revoke anything from service_role or postgres", () => {
    expect(FLAT_CODE).not.toMatch(/revoke[^;]*from\s+service_role/i);
    expect(FLAT_CODE).not.toMatch(/revoke[^;]*from\s+postgres/i);
    expect(FLAT_CODE).not.toMatch(/revoke[^;]*from\s+public\b/i);
  });

  it("makes NO schema, column, constraint, index or trigger change", () => {
    expect(FLAT_CODE).not.toMatch(/\bcreate table\b|\balter table\b/i);
    expect(FLAT_CODE).not.toMatch(/\badd column\b|\bdrop column\b/i);
    expect(FLAT_CODE).not.toMatch(/\bcreate index\b|\bdrop index\b/i);
    expect(FLAT_CODE).not.toMatch(/\bcreate trigger\b|\bdrop trigger\b/i);
    expect(FLAT_CODE).not.toMatch(/\bcreate (or replace )?function\b/i);
  });

  it("performs NO data write of any kind", () => {
    expect(FLAT_CODE).not.toMatch(/\binsert\s+into\b/i);
    expect(FLAT_CODE).not.toMatch(/\bupdate\s+public\./i);
    expect(FLAT_CODE).not.toMatch(/\bdelete\s+from\b/i);
    expect(FLAT_CODE).not.toMatch(/\btruncate\b/i);
  });

  it("does not touch the frozen 0162 trigger or function", () => {
    expect(FLAT_CODE).not.toMatch(/enforce_intake_terminal_immutability/i);
    expect(FLAT_CODE).not.toMatch(/client_intake_forms_terminal_immutability/i);
  });
});

describe("0163 — states its scope honestly", () => {
  it("names both legitimate service-role INSERT writers", () => {
    expect(PROSE).toMatch(/ensureIntakeForClient/);
    expect(PROSE).toMatch(/createIntakeRequestForClient/);
    expect(PROSE).toMatch(/createAdminClient/);
  });

  it("explains the residual it closes and that 0162 could not reach it", () => {
    expect(PROSE).toMatch(/BEFORE \*{0,2}UPDATE\*{0,2} trigger/i);
    expect(PROSE).toMatch(/never fires on INSERT/i);
    expect(PROSE).toMatch(/already[^.]{0,40}reviewed/i);
  });

  it("explicitly does NOT claim L18 is closed", () => {
    expect(PROSE).toMatch(/NOT a general treatment of L18|Do not describe L18 as closed/i);
    expect(PROSE).toMatch(
      /authenticated. retains direct row DML|retains direct row DML on the other clinical tables/i,
    );
  });

  it("records that it rewrites no row, so it repairs nothing", () => {
    expect(PROSE).toMatch(/rewrites no row/i);
    expect(PROSE).toMatch(/separate,? explicitly authorized reconciliation/i);
  });
});
