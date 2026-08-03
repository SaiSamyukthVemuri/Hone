import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
const HELPERS = [
  "assert_session_writable",
  "assert_block_in_session",
  "write_electrolysis_entry",
  "apply_block_extra_fields",
];

describe("0166 — repo migration-max tripwire (derived)", () => {
  // The "nothing above me" tripwire moved to 0167's own test when that
  // migration landed: only the CURRENT repository maximum may assert it.
  // 0166 keeps only the claim that is true forever — its own transition.
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

  it("the block patch is a STRICT enumerated allow-list, not a generic updater", () => {
    const body = FLAT.slice(
      FLAT.indexOf("function public.apply_block_extra_fields"),
      FLAT.indexOf("COMMAND 1"),
    );
    // Every accepted key enumerated in SQL.
    for (const k of ["block_name", "block_notes", "probe_type", "probe_size",
                     "started_at", "ended_at"]) {
      expect(body, `${k} must be enumerated`).toMatch(new RegExp(`'${k}'`));
    }
    // Unknown keys raise rather than being ignored.
    expect(body).toMatch(/Unsupported block field/);
    // Key PRESENCE, not COALESCE, distinguishes omitted from explicitly-null.
    expect(body).toMatch(/p_extra \? '/);
    expect(body).toMatch(/case when/i);
    // No generic mechanism.
    expect(body).not.toMatch(/execute format|jsonb_populate_record|hstore/i);
    // Protected columns are simply absent from the list.
    for (const k of ["studio_id", "session_id", "sort_order", "deleted_by", "created_at"]) {
      expect(body, `${k} must be unreachable`).not.toMatch(new RegExp(`'${k}'`));
    }
  });

  it("the extra fields are applied inside the SAME transaction as 0129", () => {
    expect(FLAT).toMatch(/public\.apply_block_extra_fields\(v_block_id, p_block_extra\)/);
    expect(FLAT).toMatch(/public\.apply_block_extra_fields\(p_block_id, p_block_extra\)/);
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
    expect((SQL.match(/^revoke execute on function/gm) ?? []).length).toBe(32);
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
  it("records the verified writer census it replaces, and the after-state", () => {
    expect(PROSE).toMatch(/session_blocks \(7\)/);
    expect(PROSE).toMatch(/electrolysis_entries \(4\)/);
    expect(PROSE).toMatch(/session_block_areas \(0\)/);
    expect(PROSE).toMatch(/session_blocks 0, electrolysis_entries 0/);
  });

  it("names every 0129 field gap it had to close", () => {
    for (const f of [
      "block_notes",
      "probe_size",
      "block_name",
      "probe_type",
      "started_at",
      "ended_at",
      "probe_inventory_item_id",
    ]) {
      expect(PROSE, `${f} must be documented as a closed gap`).toContain(f);
    }
  });
  it("does NOT claim L18 is closed", () => {
    expect(PROSE).toMatch(/L18 REMAINS OPEN/i);
  });
});

// ===========================================================================
// The four silent field-drops this migration had to close, each pinned to the
// specific 0129 gap that caused it. Routing every application writer through
// 0129 without these would have stopped persisting real clinical data.
// ===========================================================================

describe("0166 — no field 0129 drops is silently lost", () => {
  const ALLOW = /v_allowed constant text\[\] := array\[([\s\S]*?)\];/.exec(SQL)?.[1] ?? "";

  it("the block patch allow-list is exactly the seven 0129 does not own", () => {
    const keys = [...ALLOW.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(keys).toEqual([
      "block_name",
      "block_notes",
      "ended_at",
      "probe_inventory_item_id",
      "probe_size",
      "probe_type",
      "started_at",
    ]);
  });

  it("every allow-listed key is written by key PRESENCE, and cast explicitly", () => {
    for (const k of ["block_name", "block_notes", "probe_type", "probe_size"]) {
      expect(SQL, `${k} must be written by key presence`).toContain(
        `${k} = case when p_extra ? '${k}'`,
      );
    }
    expect(SQL).toMatch(/started_at = case when p_extra \? 'started_at'[\s\S]{0,90}::timestamptz/);
    expect(SQL).toMatch(/ended_at = case when p_extra \? 'ended_at'[\s\S]{0,90}::timestamptz/);
    expect(SQL).toMatch(
      /probe_inventory_item_id = case when p_extra \? 'probe_inventory_item_id'[\s\S]{0,120}::uuid/,
    );
  });

  it("an ABSENT area set preserves the recorded areas instead of clearing them", () => {
    // 0129's update ALWAYS replaces the set, so coalescing null to '[]' would
    // delete the areas of every legacy single-area edit.
    expect(SQL).toMatch(/if p_areas is null then/);
    expect(SQL).toMatch(/from public\.session_block_areas a/);
    expect(SQL).toMatch(/v_areas, p_expected_updated_at/);
    expect(SQL).not.toMatch(/coalesce\(p_areas, '\[\]'::jsonb\), p_expected_updated_at/);
  });

  it("the auto-created default block keeps the fields 0129's INSERT omits", () => {
    // add_electrolysis_pass creates the first block for a block-less session.
    expect(SQL).toMatch(
      /unnest\(array\['block_notes','probe_type','probe_size','started_at','ended_at'\]\)/,
    );
  });

  it("the entry UPDATE never wipes an existing probe_type", () => {
    const upd = /update public\.electrolysis_entries e([\s\S]*?)returning e\.id into v_id;/.exec(SQL)?.[1] ?? "";
    expect(upd).not.toMatch(/probe_type\s*=/);
    expect(upd).not.toMatch(/probe_size\s*=/);
    expect(upd).not.toMatch(/probe_lot_id\s*=/);
    // ...but INSERT still sets probe_type, where the column starts empty.
    expect(SQL).toMatch(/probe_type, machine_frequency, hairs_treated/);
  });

  it("carries no parameter that writes nothing", () => {
    // electrolysis_entries has no probe_inventory_item_id column, so a
    // p_probe_inventory_item_id entry parameter would silently discard its value.
    expect(SQL).not.toMatch(/p_probe_inventory_item_id/);
  });
});
