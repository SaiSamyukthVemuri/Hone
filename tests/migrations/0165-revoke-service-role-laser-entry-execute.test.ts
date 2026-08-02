import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Migration 0165 — revoke the unintended `service_role` EXECUTE that 0164 left
// on `create_laser_entry`. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE
// to anon, authenticated AND service_role at create time; 0164 revoked only
// from public and anon, so service_role kept it — the same defect 0129/0130
// had, one role over.
//
// This file carries the REPO migration-max pin (it moved off the 0164 test when
// 0165 landed). 0165 is NOT applied, so it is deliberately NOT checksum-frozen.
//
// Behavioural proof: tests/db/entry-create-commands.db.test.ts.

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith("0165_")) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const PROSE = SQL.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const FLAT_CODE = CODE.replace(/\s+/g, " ");

describe("0165 — service_role EXECUTE repair (repo migration-max tripwire)", () => {
  it("is present, 0164 precedes it, exactly one 0165, and it is the repo max", () => {
    expect(FILE).toMatch(/^0165_.*\.sql$/);
    const files = readdirSync(MIG_DIR);
    expect(files.some((f) => f.startsWith("0164_"))).toBe(true);
    expect(files.filter((f) => /^0165_/.test(f))).toHaveLength(1);
    expect(files.filter((f) => /^01(6[6-9]|[7-9]\d)_/.test(f))).toEqual([]);
    expect(files.filter((f) => /^0[2-9]\d\d_/.test(f))).toEqual([]);
    const nums = files
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .map((f) => parseInt(f.slice(0, 4), 10))
      .sort((a, b) => a - b);
    expect(nums[nums.length - 1]).toBe(165);
    expect(new Set(nums).size).toBe(nums.length);
    expect(files.filter((f) => /^0158_/.test(f))).toEqual([]);
  });

  it("declares its migration-max transition", () => {
    expect(PROSE).toMatch(/Migration max 0164 -> 0165/i);
  });
});

describe("0165 — transactional with an armed lock_timeout", () => {
  it("opens its own transaction and commits exactly once", () => {
    expect(CODE.match(/^\s*begin\s*;/gim) ?? []).toHaveLength(1);
    expect(CODE.match(/^\s*commit\s*;/gim) ?? []).toHaveLength(1);
  });

  it("arms lock_timeout INSIDE the transaction", () => {
    const b = FLAT_CODE.search(/\bbegin\s*;/i);
    const l = FLAT_CODE.search(/set local lock_timeout\s*=\s*'5s'/i);
    const c = FLAT_CODE.search(/\bcommit\s*;/i);
    expect(b).toBeGreaterThan(-1);
    expect(l).toBeGreaterThan(b);
    expect(c).toBeGreaterThan(l);
  });

  it("explains the 25P01 lesson", () => {
    expect(PROSE).toMatch(/does NOT wrap a migration file in an explicit transaction/i);
    expect(PROSE).toMatch(/25P01/);
  });
});

describe("0165 — revokes exactly one grant on exactly one signature", () => {
  it("revokes EXECUTE from service_role on the exact signature", () => {
    expect(FLAT_CODE).toMatch(
      /revoke execute on function public\.create_laser_entry\(\s*uuid, uuid, text, integer, jsonb, text\s*\) from service_role/i,
    );
  });

  it("contains exactly one REVOKE and no GRANT", () => {
    expect(CODE.match(/\brevoke\b/gi) ?? []).toHaveLength(1);
    expect(CODE.match(/\bgrant\b/gi) ?? []).toEqual([]);
  });

  it("does NOT touch authenticated, anon or public EXECUTE", () => {
    expect(FLAT_CODE).not.toMatch(/from authenticated/i);
    expect(FLAT_CODE).not.toMatch(/from anon/i);
    expect(FLAT_CODE).not.toMatch(/from public\s*;/i);
  });

  it("does NOT recreate or replace the function", () => {
    expect(FLAT_CODE).not.toMatch(/create or replace function/i);
    expect(FLAT_CODE).not.toMatch(/drop function/i);
    expect(FLAT_CODE).not.toMatch(/alter function/i);
  });

  it("does NOT reference create_electrolysis_entry", () => {
    expect(FLAT_CODE).not.toMatch(/create_electrolysis_entry/i);
  });

  it("does NOT change global ALTER DEFAULT PRIVILEGES", () => {
    expect(FLAT_CODE).not.toMatch(/alter default privileges/i);
  });

  it("makes no schema, policy, trigger or data change", () => {
    expect(FLAT_CODE).not.toMatch(/\bcreate table\b|\balter table\b/i);
    expect(FLAT_CODE).not.toMatch(/\bcreate policy\b|\bdrop policy\b/i);
    expect(FLAT_CODE).not.toMatch(/\bcreate trigger\b|\bdrop trigger\b/i);
    expect(FLAT_CODE).not.toMatch(/\binsert into\b|\bupdate public\.|\bdelete from\b|\btruncate\b/i);
  });

  it("revokes NO table privilege — Phase 1A stays additive", () => {
    expect(FLAT_CODE).not.toMatch(
      /revoke[^;]*on public\.(laser_entries|electrolysis_entries)/i,
    );
  });
});

describe("0165 — records the defect honestly", () => {
  it("names 0164's false 'no service_role grant' claim", () => {
    expect(PROSE).toMatch(/deliberately no service_role grant/i);
    expect(PROSE).toMatch(/FALSE as deployed/i);
  });

  it("names the deployed ACL it repairs", () => {
    expect(PROSE).toMatch(/service_role=X\/postgres/);
  });

  it("names the 0129/0130 precedent it repeated", () => {
    expect(PROSE).toMatch(/0129/);
    expect(PROSE).toMatch(/0130/);
    expect(PROSE).toMatch(/ALTER DEFAULT PRIVILEGES/i);
  });

  it("states the exposure honestly rather than minimising or overstating", () => {
    expect(PROSE).toMatch(/auth\.uid\(\) is null/i);
    expect(PROSE).toMatch(/check_violation/i);
    expect(PROSE).toMatch(/EXPOSURE: NONE FOUND/i);
  });

  it("does not claim L18 progress", () => {
    expect(PROSE).toMatch(/L18 REMAINS PARTIAL AND OPEN/i);
    expect(PROSE).toMatch(/moves no writer/i);
  });

  it("states that frozen 0164 is not edited, and names its checksum", () => {
    expect(PROSE).toMatch(/is NOT edited by this migration/i);
    expect(PROSE).toMatch(
      /a1f3aa2754378ee5c171d62fa2a60b5c787801953f4a887b031db4ec439a3826/,
    );
  });
});
