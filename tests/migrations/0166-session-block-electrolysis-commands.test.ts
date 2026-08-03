import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isRepoMax, versionsAbove } from "./helpers/migration-state";

// Migration 0166 — L18 Phase 2. Narrow commands for session_blocks +
// electrolysis_entries. Behavioural proof lives in
// tests/db/session-block-electrolysis-commands.db.test.ts.
//
// The repo max is DERIVED (PR #502) — this file hard-codes only its own version.

/** This file's own migration version — the ONLY number it hard-codes. */
const SELF_VERSION = "0166";

const MIG_DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(MIG_DIR).find((f) => f.startsWith(`${SELF_VERSION}_`)) as string;
const SQL = readFileSync(join(MIG_DIR, FILE), "utf8");
const PROSE = SQL.replace(/^\s*--\s?/gm, "").replace(/\s+/g, " ");
const CODE = SQL.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const FLAT = CODE.replace(/\s+/g, " ");

const COMMANDS = [
  "create_block_with_entry",
  "update_block_with_entry",
  "add_electrolysis_pass",
  "soft_delete_session_block",
];
const HELPERS = ["assert_session_writable", "assert_block_in_session", "write_electrolysis_entry"];

describe("0166 — repo migration-max tripwire (derived)", () => {
  it("is the repo max and nothing above it exists", () => {
    expect(isRepoMax(SELF_VERSION)).toBe(true);
    expect(versionsAbove(SELF_VERSION)).toEqual([]);
  });
  it("declares its migration-max transition", () => {
    expect(PROSE).toMatch(/Migration max 0165 -> 0166/i);
  });
});

describe("0166 — transactional with an armed lock_timeout", () => {
  it("opens its own transaction and commits once", () => {
    expect(CODE.match(/^\s*begin\s*;/gim) ?? []).toHaveLength(1);
    expect(CODE.match(/^\s*commit\s*;/gim) ?? []).toHaveLength(1);
  });
  it("arms lock_timeout inside the transaction", () => {
    expect(FLAT).toMatch(/set local lock_timeout = '5s'/i);
  });
});

describe("0166 — every command meets the security contract", () => {
  for (const fn of [...COMMANDS, ...HELPERS]) {
    it(`${fn}: SECURITY DEFINER with an empty search_path`, () => {
      const body = FLAT.slice(FLAT.indexOf(`create or replace function public.${fn}`));
      expect(body).toMatch(/security definer/i);
      expect(body).toMatch(/set search_path = ''/i);
    });
  }

  it("derives the actor from auth.uid(), never current_user", () => {
    expect(FLAT).toMatch(/auth\.uid\(\)/);
    expect(FLAT, "current_user is the DEFINER, not the caller").not.toMatch(/current_user/i);
  });

  it("no command takes a caller-supplied studio or actor identity", () => {
    for (const fn of COMMANDS) {
      const sig = FLAT.slice(
        FLAT.indexOf(`create or replace function public.${fn}`),
        FLAT.indexOf("returns", FLAT.indexOf(`function public.${fn}`)),
      );
      expect(sig, `${fn}`).not.toMatch(/p_studio_id|p_practitioner_id|p_deleted_by|p_actor/i);
    }
  });

  it("derives deleted_by from auth.uid() on the soft-delete path", () => {
    expect(FLAT).toMatch(/deleted_by = v_practitioner_id/);
    expect(PROSE).toMatch(/deleted_by is DERIVED from auth\.uid\(\)/i);
  });

  it("fully qualifies every relation and called function", () => {
    // No bare table references inside the function bodies.
    expect(FLAT).not.toMatch(/\bfrom (session_blocks|electrolysis_entries|sessions|practitioners)\b/);
    expect(FLAT).toMatch(/public\.create_session_block_with_areas/);
    expect(FLAT).toMatch(/public\.update_session_block_with_areas/);
  });

  it("reuses the 0128/0129 area boundary instead of a competing path", () => {
    expect(FLAT).toMatch(/public\.create_session_block_with_areas\(/);
    expect(FLAT).toMatch(/public\.update_session_block_with_areas\(/);
    // It must NOT write session_block_areas directly.
    expect(FLAT).not.toMatch(/insert into public\.session_block_areas/i);
    expect(FLAT).not.toMatch(/delete from public\.session_block_areas/i);
  });

  it("accepts no arbitrary column/value update map for entries", () => {
    // Bound the slice to THIS function — otherwise it runs on into the grant
    // DO-block, whose `execute format` is legitimate DDL, not a value map.
    const start = FLAT.indexOf("function public.write_electrolysis_entry");
    const next = FLAT.indexOf("create or replace function", start + 10);
    const body = FLAT.slice(start, next === -1 ? undefined : next);
    expect(body).not.toMatch(/jsonb_populate_record|jsonb_each|hstore/i);
    expect(body).not.toMatch(/execute format/i);
  });

  it("soft-deletes only — never a hard delete of clinical history", () => {
    expect(FLAT).not.toMatch(/delete from public\.(session_blocks|electrolysis_entries)/i);
    expect(FLAT).toMatch(/set deleted_at = now\(\)/);
  });

  it("locks parent rows in a stable order before coupled mutation", () => {
    expect(FLAT).toMatch(/for update/i);
    expect(PROSE).toMatch(/stable order/i);
  });

  it("galvanic_intensity_percent is retired: not a parameter, always NULL", () => {
    for (const fn of COMMANDS) {
      const sig = FLAT.slice(
        FLAT.indexOf(`create or replace function public.${fn}`),
        FLAT.indexOf("returns", FLAT.indexOf(`function public.${fn}`)),
      );
      expect(sig).not.toMatch(/p_galvanic_intensity_percent/i);
    }
  });
});

describe("0166 — least-privilege EXECUTE", () => {
  it("revokes from PUBLIC, anon, service_role AND authenticated for EVERY function", () => {
    for (const fn of [...COMMANDS, ...HELPERS]) {
      for (const role of ["public", "anon", "service_role", "authenticated"]) {
        expect(FLAT, `${fn} must revoke from ${role}`).toMatch(
          new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from ${role}`, "i"),
        );
      }
    }
  });

  it("uses literal REVOKE statements, not a dynamic DO-block", () => {
    // A format()-driven revoke is correct at runtime but unauditable by
    // reading and invisible to the grant guard.
    expect(FLAT).not.toMatch(/do \$\$[\s\S]*revoke execute/i);
    expect((SQL.match(/^revoke execute on function/gm) ?? []).length).toBe(28);
    expect((SQL.match(/^grant execute on function/gm) ?? []).length).toBe(4);
  });

  it("grants EXECUTE to authenticated for the four capability commands only", () => {
    for (const fn of COMMANDS) {
      expect(FLAT).toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`, "i"),
      );
    }
    for (const fn of HELPERS) {
      expect(FLAT, `${fn} must stay internal`).not.toMatch(
        new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to authenticated`, "i"),
      );
    }
  });

  it("grants to no other role", () => {
    expect(FLAT).not.toMatch(/grant execute[^;]*to[^;]*service_role/i);
    expect(FLAT).not.toMatch(/grant execute[^;]*to[^;]*anon/i);
  });

  it("carries the 0129/0164 default-privilege lesson", () => {
    expect(PROSE).toMatch(/ALTER DEFAULT PRIVILEGES/i);
    expect(PROSE).toMatch(/0129 revoked\s*only from public/i);
    expect(PROSE).toMatch(/0164 revoked public\+anon and\s*left service_role/i);
  });
});

describe("0166 — additive and honest about scope", () => {
  it("revokes no table privilege and drops no policy", () => {
    expect(FLAT).not.toMatch(/revoke[^;]*on public\.(session_blocks|electrolysis_entries|sessions)/i);
    expect(FLAT).not.toMatch(/drop policy/i);
  });
  it("makes no schema, trigger or data change", () => {
    expect(FLAT).not.toMatch(/\bcreate table\b|\balter table\b|\bcreate trigger\b|\bdrop trigger\b/i);
    expect(FLAT).not.toMatch(/\btruncate\b/i);
  });
  it("records the verified writer census it replaces", () => {
    expect(PROSE).toMatch(/session_blocks \(7\)/);
    expect(PROSE).toMatch(/electrolysis_entries \(4\)/);
    expect(PROSE).toMatch(/session_block_areas \(0\)/);
  });
  it("does NOT claim L18 is closed", () => {
    expect(PROSE).toMatch(/L18 REMAINS OPEN/i);
  });
});
