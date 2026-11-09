import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0323 — launch controls (closed + invited booking, and the competing-invitation count). STATIC contract. Behaviour is proved against a real
// database in tests/db/waitlist-launch-controls.db.test.ts.

const root = join(__dirname, "..", "..");
const M = readFileSync(join(root, "supabase/migrations/0323_waitlist_launch_controls.sql"), "utf8");
const DOWN = readFileSync(join(root, "supabase/rollbacks/0323_waitlist_launch_controls.down.sql"), "utf8");
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(M);
const FN = "public.count_competing_waitlist_invitations(uuid, date, date, integer[])";
const MARKER = "public.waitlist_closed_invited_booking_enabled()";
const ASSERT = "public.assert_new_client_admission(uuid, text, boolean)";
const fnDef = (name: string) => E.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\$\\$;`))![0];

describe("0323 — migration state", () => {
  it("consumes exactly one number", () => {
    expect(countVersion("0323")).toBe(1);
  });
});

describe("0323 — shape", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const e = E.trim();
    expect(e).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(e.endsWith("commit;")).toBe(true);
  });

  it("the matrix: invited_book passes open, waitlist and closed; book and join_waitlist are unchanged", () => {
    const def = fnDef("assert_new_client_admission");
    expect(def).toMatch(/when 'invited_book' then\s+case\s+when v_mode in \('open', 'waitlist', 'closed'\) then 'ok'/);
    expect(def).toMatch(/when 'book' then\s+case when v_mode = 'open' then 'ok'/);
    expect(def).toMatch(/when 'join_waitlist' then\s+case when v_mode = 'waitlist' then 'ok'/);
    expect(def).toMatch(/set search_path = pg_catalog, public, pg_temp/);
  });

  it("the matrix function differs from 0204's in the invited_book cell and its comment, and NOTHING else", () => {
    const grab = (sql: string) =>
      sql.match(/create or replace function public\.assert_new_client_admission\([\s\S]*?\n\$\$;/)![0].split("\n");
    const old = grab(readFileSync(join(root, "supabase/migrations/0204_new_client_admission_mode.sql"), "utf8"));
    const now = grab(M);
    // The only intended edits: the preceding header comment (line 0 of the grab is the create line,
    // which both share) and the invited_book comment block + cell.
    const strip = (lines: string[]) => lines.filter((l) => !/^\s*--/.test(l));
    const oldCode = strip(old).map((l) => l.replace("when v_mode in ('open', 'waitlist') then 'ok'", "<CELL>"));
    const newCode = strip(now).map((l) => l.replace("when v_mode in ('open', 'waitlist', 'closed') then 'ok'", "<CELL>"));
    expect(newCode).toEqual(oldCode);
    expect(oldCode.filter((l) => l.includes("<CELL>")).length).toBe(1);
    // and the 0204 body is not byte-identical, so the cell really did change
    expect(now.join("\n")).not.toBe(old.join("\n"));
  });

  it("the marker exists in the same migration, returns only true, and is granted to service_role alone", () => {
    const def = fnDef("waitlist_closed_invited_booking_enabled");
    expect(def).toMatch(/returns boolean/);
    expect(def).toMatch(/select true/);
    expect(def).toMatch(/set search_path = pg_catalog, pg_temp/);
    expect(E).toContain(`revoke all on function ${MARKER} from public, anon, authenticated, service_role;`);
    expect(E).toContain(`grant execute on function ${MARKER} to service_role;`);
    expect(E).toContain(`revoke all on function ${ASSERT} from public, anon, authenticated, service_role;`);
  });

  it("is a stable definer function with a pinned search_path that returns one integer", () => {
    const def = fnDef("count_competing_waitlist_invitations");
    expect(def).toMatch(/returns integer/);
    expect(def).toMatch(/stable security definer/);
    expect(def).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("re-proves ownership from auth.uid() before reading anything", () => {
    const def = fnDef("count_competing_waitlist_invitations");
    const gate = def.indexOf("is_studio_owner(p_studio_id)");
    expect(gate).toBeGreaterThan(0);
    expect(def.indexOf("auth.uid()")).toBeGreaterThan(0);
    expect(def.indexOf("new_client_waitlist_invitations")).toBeGreaterThan(gate);
    expect(def).toMatch(/errcode = '42501'/);
  });

  it("revokes all four default grantees by name, then grants authenticated only", () => {
    expect(E).toContain(`revoke all on function ${FN} from public, anon, authenticated, service_role;`);
    expect(E).toContain(`grant execute on function ${FN} to authenticated;`);
    expect(E.match(/grant execute on function/g)!.length).toBe(2); // the count function and the marker
  });

  it("is read-only", () => {
    const def = fnDef("count_competing_waitlist_invitations");
    expect(def).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  });

  it("carries a self-check on the grants", () => {
    expect(E).toMatch(/has_function_privilege/);
    expect(E).toMatch(/aclexplode/);
  });
});

describe("0323 — rollback", () => {
  it("restores the 0204 matrix byte for byte and drops the new functions, inside its own transaction", () => {
    const d = exec(DOWN).trim();
    const body = (sql: string) => sql.match(/create or replace function public\.assert_new_client_admission\([\s\S]*?\n\$\$;/)![0];
    expect(body(d)).toBe(body(exec(readFileSync(join(root, "supabase/migrations/0204_new_client_admission_mode.sql"), "utf8"))));
    expect(d).toContain(`drop function if exists ${MARKER};`);
    expect(d).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(d).toContain(`drop function if exists ${FN};`);
    expect(d.endsWith("commit;")).toBe(true);
    expect(d).not.toMatch(/drop table/i);
  });
});
