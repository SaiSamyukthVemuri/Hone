import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// ===========================================================================
// L18 Phase 3, migration 0167 source contract.
//
// Deterministic assertions about the migration BYTES. Behaviour lives in
// tests/db/session-write-commands.db.test.ts; this file pins the shape that
// review depends on, so a later edit cannot quietly widen the boundary.
// ===========================================================================

const FILE = "supabase/migrations/0167_session_write_commands.sql";
const SQL = readFileSync(FILE, "utf8");
const FLAT = SQL.replace(/\s+/g, " ");
const PROSE = SQL.split("\n")
  .filter((l) => l.trimStart().startsWith("--"))
  .join("\n");

const PUBLIC_COMMANDS: ReadonlyArray<{ name: string; args: string }> = [
  { name: "start_session", args: "uuid, text, uuid, integer" },
  { name: "set_session_price", args: "uuid, uuid, integer" },
  { name: "set_next_session_note", args: "uuid, uuid, text" },
  { name: "set_session_performer", args: "uuid, uuid, uuid" },
  { name: "edit_session_started_at", args: "uuid, uuid, timestamptz" },
  { name: "soft_delete_session", args: "uuid, uuid, text" },
  { name: "set_session_treatment_plan", args: "uuid, uuid, uuid" },
  { name: "set_session_aftercare_explained", args: "uuid, boolean" },
];
const HELPERS: ReadonlyArray<{ name: string; args: string }> = [
  { name: "session_actor_practitioner", args: "uuid" },
  { name: "assert_session_studio_for_actor", args: "uuid" },
];
const ALL = [...PUBLIC_COMMANDS, ...HELPERS];

// The "nothing above me" tripwire moved to 0168's own test when that migration
// landed: only the CURRENT repository maximum may assert it.

describe("0167: function shape", () => {
  it("declares exactly eight public commands and two internal helpers", () => {
    const declared = [...SQL.matchAll(/create or replace function public\.(\w+)\(/g)].map(
      (m) => m[1],
    );
    expect(declared.sort()).toEqual(ALL.map((f) => f.name).sort());
  });

  it("every function is SECURITY DEFINER with an empty search_path", () => {
    const bodies = SQL.split("create or replace function public.").slice(1);
    expect(bodies).toHaveLength(ALL.length);
    for (const b of bodies) {
      const head = b.slice(0, b.indexOf("as $$"));
      expect(head).toMatch(/security definer/);
      expect(head).toMatch(/set search_path = ''/);
    }
  });

  it("never consults current_user as the actor", () => {
    // Inside a SECURITY DEFINER function current_user is the OWNER, not the
    // authenticated practitioner. Strip comments first, the migration
    // DOCUMENTS this rule in prose, which is the point.
    const code = SQL.split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(code).not.toMatch(/current_user/);
    expect(SQL).toMatch(/auth\.uid\(\)/);
  });

  it("uses no dynamic SQL and no generic patch mechanism", () => {
    expect(FLAT).not.toMatch(/execute format/i);
    expect(FLAT).not.toMatch(/quote_ident/i);
    expect(FLAT).not.toMatch(/jsonb_populate_record/i);
    // No command takes a free-form column bag.
    expect(FLAT).not.toMatch(/p_fields/);
    expect(FLAT).not.toMatch(/p_patch/);
  });

  it("accepts no studio id or actor id from the caller", () => {
    // Both are DERIVED. A p_studio_id / p_practitioner_id parameter on a PUBLIC
    // command would let a caller assert its own tenant.
    for (const c of PUBLIC_COMMANDS) {
      const seg = SQL.slice(
        SQL.indexOf(`create or replace function public.${c.name}(`),
      ).slice(0, 900);
      const params = seg.slice(0, seg.indexOf(")"));
      expect(params, `${c.name} must not take a studio id`).not.toMatch(/p_studio_id/);
      expect(params, `${c.name} must not take an actor id`).not.toMatch(
        /p_practitioner_id|p_actor/,
      );
    }
  });

  it("writes no protected or lifecycle column", () => {
    // record_status is the retired finalization lifecycle; id/studio_id/
    // created_at are never re-assigned by these commands.
    expect(FLAT).not.toMatch(/set record_status/);
    expect(FLAT).not.toMatch(/record_origin/);
    expect(FLAT).not.toMatch(/legacy_classification/);
  });

  it("soft delete is SOFT: no hard DELETE against sessions anywhere", () => {
    expect(FLAT).not.toMatch(/delete from public\.sessions/i);
    expect(SQL).toMatch(/set deleted_at\s*=\s*now\(\)/);
    expect(SQL).toMatch(/deleted_by\s*=\s*v_practitioner/);
  });

  it("closes the start-session race with FOR UPDATE", () => {
    const seg = SQL.slice(SQL.indexOf("function public.start_session("));
    expect(seg.slice(0, seg.indexOf("$$;"))).toMatch(/for update/);
  });

  it("writes the started_at audit row in the same function body", () => {
    const seg = SQL.slice(SQL.indexOf("function public.edit_session_started_at("));
    const body = seg.slice(0, seg.indexOf("$$;"));
    expect(body).toMatch(/insert into public\.session_audit/);
    expect(body).toMatch(/'started_at'/);
  });
});

describe("0167: privileges", () => {
  it("revokes every signature from all four grantees, literally", () => {
    for (const f of ALL) {
      for (const role of ["public", "anon", "service_role", "authenticated"]) {
        expect(
          SQL,
          `${f.name} must be revoked from ${role}`,
        ).toContain(
          `revoke execute on function public.${f.name}(${f.args}) from ${role};`,
        );
      }
    }
    expect((SQL.match(/^revoke execute on function/gm) ?? []).length).toBe(ALL.length * 4);
  });

  it("grants ONLY the eight public commands, and only to authenticated", () => {
    for (const c of PUBLIC_COMMANDS) {
      expect(SQL).toContain(
        `grant execute on function public.${c.name}(${c.args}) to authenticated;`,
      );
    }
    expect((SQL.match(/^grant execute on function/gm) ?? []).length).toBe(
      PUBLIC_COMMANDS.length,
    );
    expect(FLAT).not.toMatch(/grant execute[^;]*to[^;]*service_role/i);
    expect(FLAT).not.toMatch(/grant execute[^;]*to[^;]*anon/i);
  });

  it("never grants the internal helpers back", () => {
    for (const h of HELPERS) {
      expect(FLAT).not.toContain(`grant execute on function public.${h.name}`);
    }
  });
});

describe("0167: additive and honest about scope", () => {
  it("revokes no TABLE privilege and drops no policy", () => {
    expect(FLAT).not.toMatch(/revoke[^;]*on public\.sessions/i);
    expect(FLAT).not.toMatch(/revoke[^;]*on table/i);
    expect(FLAT).not.toMatch(/drop policy/i);
  });

  it("makes no schema, trigger or data change", () => {
    expect(FLAT).not.toMatch(/\bcreate table\b|\balter table\b|\bcreate trigger\b|\bdrop trigger\b/i);
    expect(FLAT).not.toMatch(/\btruncate\b/i);
  });

  it("opens its own transaction with an armed lock_timeout", () => {
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/^set local lock_timeout/m);
    expect(SQL).toMatch(/^commit;/m);
  });

  it("records the writer census it replaces, and the after-state", () => {
    expect(PROSE).toMatch(/sessions \(10\)/);
    expect(PROSE).toMatch(/sessions 0/);
    // treatment_images is explicitly out of scope for this phase.
    expect(PROSE).toMatch(/treatment_images REMAINS 3/);
  });

  it("does NOT claim L18 is closed", () => {
    expect(PROSE).toMatch(/L18 REMAINS OPEN/i);
    expect(PROSE).toMatch(/not revoked/i);
  });
});
