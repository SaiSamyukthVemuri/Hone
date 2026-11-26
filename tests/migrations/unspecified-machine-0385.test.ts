import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// 0385: SOURCE contract for the migration and its down file. Behaviour is the authority and is proved on a real database by
// tests/db/unspecified-machine.db.test.ts; this file pins what a database run cannot see in a diff.

const UP = readFileSync("supabase/migrations/0385_unspecified_machine.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0385_unspecified_machine.down.sql", "utf8");
const code = (s: string) => s.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const U = code(UP);

describe("0385 is shaped like a sealed migration", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(UP).toMatch(/^begin;$/m);
    expect(UP).toMatch(/^commit;$/m);
    expect(UP.indexOf("begin;")).toBeLessThan(UP.indexOf("set local lock_timeout"));
    expect(DOWN).toMatch(/^begin;$/m);
    expect(DOWN).toMatch(/^commit;$/m);
  });
});

describe("ensure_unspecified_machine", () => {
  const fn = U.slice(U.indexOf("create or replace function public.ensure_unspecified_machine"), U.indexOf("comment on function public.ensure_unspecified_machine"));
  it("is SECURITY DEFINER with a pinned search_path, taking only the studio", () => {
    expect(fn).toMatch(/ensure_unspecified_machine\(p_studio_id uuid\)/);
    expect(fn).toMatch(/security definer/);
    expect(fn).toMatch(/set search_path = pg_catalog, pg_temp/);
  });
  it("authorises through is_studio_member from auth.uid() and refuses every miss with ONE generic message", () => {
    expect(fn).toMatch(/not public\.is_studio_member\(p_studio_id\)/);
    expect(fn).toMatch(/auth\.uid\(\) is null/);
    const raises = fn.match(/raise exception '([^']+)'/g) ?? [];
    expect(raises.length).toBeGreaterThanOrEqual(2);
    for (const r of raises) expect(r).toBe("raise exception 'Machine not available.'");
    expect(fn.match(/errcode = 'insufficient_privilege'/g)?.length).toBe(raises.length);
  });
  it("fixes the profile and reads the CURRENT PUBLISHED version (highest with the multiplex contract), never a caller's", () => {
    expect(fn).toMatch(/select max\(c\.machine_profile_version\)/);
    expect(fn).toMatch(/c\.machine_profile_id = 'dectro-apilus:xcell-pur'/);
    expect(fn).toMatch(/c\.mode_key = 'multiplex'/);
    expect(fn).not.toMatch(/p_version|p_profile/);
  });
  it("ON CONFLICT names the partial-index predicate, then selects", () => {
    expect(fn).toContain("on conflict (studio_id, machine_profile_id, machine_profile_version) where is_unspecified");
    expect(fn).toMatch(/do nothing;\s*select m\.id/);
  });
  it("returns the id only", () => expect(fn).toMatch(/returns uuid/));
});

describe("grants: authenticated only, the other three revoked by name", () => {
  it.each([
    "public.ensure_unspecified_machine(uuid)",
    "public.register_studio_machine(uuid, text, integer, text, text[])",
    "public.retire_studio_machine(uuid)",
    "public.set_own_default_machine(uuid, uuid, text)",
  ])("%s", (sig) => {
    for (const role of ["public", "anon", "service_role"]) expect(UP, role).toContain(`revoke execute on function ${sig} from ${role};`);
    expect(UP).toContain(`grant execute on function ${sig} to authenticated;`);
    expect(UP).not.toMatch(new RegExp(`grant[^;]*${sig.replace(/[()]/g, "\\$&")}[^;]*to\\s+(anon|service_role|public)`, "i"));
  });
  it("the trigger function is revoked from every role too", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) expect(UP).toContain(`revoke execute on function public.refuse_unspecified_machine_change() from ${role};`);
  });
  it("the after-check verifies the grants", () => {
    expect(UP).toContain("has_function_privilege('authenticated'");
    expect(UP).toContain("has_function_privilege('anon'");
    expect(UP).toContain("has_function_privilege('service_role'");
  });
});

describe("the table", () => {
  it("is_unspecified is a not-null boolean default false, the display-name index exempts it, one placeholder per studio, profile and version", () => {
    expect(U).toMatch(/add column if not exists is_unspecified boolean not null default false/);
    expect(U).toMatch(/studio_machines_studio_display_name_uniq\s+on public\.studio_machines \(studio_id, lower\(btrim\(display_name\)\)\)\s+where not is_unspecified/);
    expect(U).toMatch(/studio_machines_unspecified_uniq\s+on public\.studio_machines \(studio_id, machine_profile_id, machine_profile_version\)\s+where is_unspecified/);
  });
  it("the shape constraint pins the name, empty options, never retired, and the xCell Pur profile", () => {
    expect(U).toContain("display_name = 'Machine not specified'");
    expect(U).toContain("installed_options = '{}'::text[]");
    expect(U).toContain("retired_at is null");
  });
  it("the freeze trigger refuses flag changes and any change to the placeholder", () => {
    expect(U).toMatch(/is_unspecified is immutable/);
    expect(U).toMatch(/before update on public\.studio_machines/);
  });
});

describe("the three production commands that take a machine id refuse the placeholder", () => {
  it("register refuses the reserved name: whitespace (Unicode spaces included) is collapsed FIRST, then trimmed, then folded for case", () => {
    expect(U).toContain("lower(btrim(regexp_replace(coalesce(p_display_name, ''), '[[:space:]\\u00a0\\u1680\\u2000-\\u200b\\u202f\\u205f\\u3000\\ufeff]+', ' ', 'g'))) = 'machine not specified'");
  });
  it("retire and set_own_default raise on is_unspecified", () => {
    expect(U.match(/if v_unspec then/g)?.length).toBe(2);
  });
});

describe("the down", () => {
  it("is labelled an emergency measure (application first, then down) and refuses on EVERY table that references studio_machines", () => {
    expect(DOWN).toMatch(/EMERGENCY ONLY/);
    expect(DOWN).toMatch(/application must be rolled back FIRST/);
    for (const t of ["session_blocks", "treatment_setup_readings", "treatment_setup_submissions", "treatment_setup_captures", "block_write_receipts", "practitioners"]) {
      expect(DOWN, t).toMatch(new RegExp(`from public\\.${t} \\w+ join public\\.studio_machines m on m\\.id = \\w+\\.\\w+ where m\\.is_unspecified`));
    }
  });
  it("refuses when restoring the full display-name index would collide, and restores the 0223 bodies before dropping the column", () => {
    expect(DOWN).toMatch(/restoring the unique display-name index would collide/);
    expect(DOWN.indexOf("create or replace function public.register_studio_machine")).toBeLessThan(DOWN.indexOf("drop column if exists is_unspecified"));
    expect(code(DOWN)).not.toMatch(/is_unspecified[^;]*register_studio_machine|v_unspec/);
  });
});

describe("every table that references studio_machines is in the down's guard (derived from the migrations)", () => {
  it("no migration adds a reference the down does not check", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const tables = new Set<string>();
    for (const f of readdirSync("supabase/migrations").filter((x) => x.endsWith(".sql"))) {
      const sql = code(readFileSync(`supabase/migrations/${f}`, "utf8"));
      for (const m of sql.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/g)) if (/references public\.studio_machines/.test(m[2])) tables.add(m[1]);
      for (const m of sql.matchAll(/alter table (?:only )?public\.(\w+)[\s\S]{0,300}?references public\.studio_machines/g)) tables.add(m[1]);
    }
    expect([...tables].length).toBeGreaterThan(3);
    for (const t of tables) expect(DOWN, t).toContain(`public.${t} `);
  });
});

describe("the export registry names the placeholder", () => {
  it("studio_machines' registry note says the placeholder is excluded and the readings column is blanked for it", () => {
    const reg = readFileSync("lib/export/resource-registry.ts", "utf8");
    expect(reg).toContain("exclude rows where is_unspecified");
    expect(reg).toContain("must leave it blank for such a row");
  });
});
