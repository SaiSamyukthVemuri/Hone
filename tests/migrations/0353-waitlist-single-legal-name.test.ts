import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// Source contract for 0353 (waitlist single legal name: one flag column, one CHECK, one new completion command version).
// The behavioural proof is tests/db/waitlist-single-legal-name.db.test.ts.
const ROOT = join(__dirname, "..", "..");
const NEW_FILE = readFileSync(join(ROOT, "supabase/migrations/0353_waitlist_single_legal_name.sql"), "utf8");
const DOWN_FILE = readFileSync(join(ROOT, "supabase/rollbacks/0353_waitlist_single_legal_name.down.sql"), "utf8");
const V1_FILE = readFileSync(join(ROOT, "supabase/migrations/0202_waitlist_profile_and_sms_consent_authority.sql"), "utf8");

const V2_SIG = "public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean)";

const block = (sql: string, name: string): string[] => {
  const start = sql.indexOf(`create or replace function ${name}(`);
  const end = sql.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error(`${name} block not found`);
  return sql.slice(start, end + 4).replace(new RegExp(name.replace(".", "\\."), "g"), "FN").split("\n").map((l) => l.trim());
};

describe("0353 source contract", () => {
  it("is the current maximum migration (only the max may assert this)", () => {
    expect(isRepoMax("0353")).toBe(true);
  });

  it("opens its own transaction, arms lock_timeout inside it, and ends with commit", () => {
    expect(NEW_FILE).toMatch(/^begin;\n\s*set local lock_timeout = '5s';/m);
    expect(NEW_FILE.trimEnd().endsWith("commit;")).toBe(true);
  });

  it("is additive: one column, one CHECK, one new function; nothing dropped or rewritten", () => {
    expect(NEW_FILE).toMatch(/add column if not exists single_legal_name boolean not null default false/);
    expect(NEW_FILE).toMatch(/check \(not single_legal_name or last_name is null\)/);
    expect(NEW_FILE).not.toMatch(/\bdrop (table|column|function|policy|trigger|index)\b/i);
    // Outside the function body (which carries the 0202 writes, proved identical below) there is no data change at all.
    const ddl = NEW_FILE.slice(0, NEW_FILE.indexOf("create or replace function "));
    expect(ddl).not.toMatch(/\b(delete from|truncate|insert into|update public)\b/i);
    expect(NEW_FILE).not.toMatch(/create or replace function public\.complete_waitlist_profile_by_grant\(/);
    expect((NEW_FILE.match(/create or replace function /g) ?? []).length).toBe(1);
  });

  it("revokes EXECUTE from public, anon, authenticated and service_role by name, and grants only to service_role", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(NEW_FILE).toContain(`revoke execute on function ${V2_SIG} from ${role};`);
    }
    const grants = NEW_FILE.match(/^grant .*$/gim) ?? [];
    expect(grants).toEqual([`grant execute on function ${V2_SIG} to service_role;`]);
    expect(NEW_FILE).toMatch(/security definer\nset search_path = pg_catalog, pg_temp/);
  });

  it("differs from the live 0202 v1 body only by the single-name rule and the new flag", () => {
    const v1 = block(V1_FILE, "public.complete_waitlist_profile_by_grant");
    const v2 = block(NEW_FILE, "public.complete_waitlist_profile_by_grant_v2");
    const removed = v1.filter((l) => !v2.includes(l));
    const added = v2.filter((l) => !v1.includes(l));
    expect(removed).toEqual([
      "p_sms_consent        boolean",
      "if p_raw_token is null or p_sms_consent is null then",
      "or v_last = '' or length(v_last) > 60",
      "select e.first_name, e.last_name, e.treatment_area_ids, e.phone,",
      "and v_entry_row.last_name          is not distinct from v_last",
      "last_name          = v_last,",
    ]);
    for (const l of added) {
      expect(l, l).toMatch(/single|^--|^p_sms_consent {8}boolean,$/);
    }
    expect(added.some((l) => /^p_single_name\s+boolean$/.test(l))).toBe(true);
  });

  it("the down file drops the function, the CHECK and the column, in that order", () => {
    expect(DOWN_FILE).toMatch(/^begin;\nset local lock_timeout = '5s';/m);
    expect(DOWN_FILE.trimEnd().endsWith("commit;")).toBe(true);
    const f = DOWN_FILE.indexOf("drop function if exists public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean);");
    const c = DOWN_FILE.indexOf("drop constraint if exists new_client_waitlist_entries_single_name_check");
    const col = DOWN_FILE.indexOf("drop column if exists single_legal_name");
    expect(f).toBeGreaterThan(-1);
    expect(c).toBeGreaterThan(f);
    expect(col).toBeGreaterThan(c);
  });
});
