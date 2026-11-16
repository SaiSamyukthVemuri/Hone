import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion } from "./helpers/migration-state";

// 0354: STATIC contract only. Behaviour (and agreement with the TypeScript resolver) is proved against a real database in
// tests/db/appointment-quoted-amount-parity.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0354_quoted_amount_explicit_zero_custom_price";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const E = exec(readFileSync(join(root, `supabase/migrations/${NAME}.sql`), "utf8"));
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));
const M0187 = exec(readFileSync(join(root, "supabase/migrations/0187_appointment_settlement.sql"), "utf8"));
const fn = (sql: string) => {
  const a = sql.indexOf("create or replace function public.appointment_quoted_amount_cents");
  return sql.slice(a, sql.indexOf("$$;", sql.indexOf("as $$", a)) + 3);
};

describe("0354: shape", () => {
  it("consumes exactly one number", () => expect(countVersion("0354")).toBe(1));
  it("opens its own transaction and arms lock_timeout inside it", () => {
    expect(E.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(E.trim().endsWith("commit;")).toBe(true);
  });
  it("replaces ONE function with the 0187 signature and attributes, and nothing else", () => {
    expect(E.match(/create or replace function/g)).toHaveLength(1);
    expect(E).toMatch(/appointment_quoted_amount_cents\(\s*p_studio_id uuid,\s*p_appointment_id uuid\s*\)\s*returns integer\s*language plpgsql\s*stable\s*security definer\s*set search_path = pg_catalog, pg_temp/);
    expect(E).not.toMatch(/\b(alter table|create table|drop |insert into|update public|delete from)\b/);
  });
  it("revokes EXECUTE from all four roles by name, as 0187 does", () => {
    for (const r of ["public", "anon", "authenticated", "service_role"]) {
      expect(E).toContain(`revoke all privileges on function public.appointment_quoted_amount_cents(uuid, uuid) from ${r};`);
    }
    expect(E).not.toMatch(/\bgrant\b/);
  });
  it("no longer filters custom rows by price_cents > 0, and a negative winner returns NULL before the tie check", () => {
    const f = fn(E);
    expect(f).not.toMatch(/cp\.price_cents > 0/);
    expect(f).toMatch(/if v_custom < 0 then\s*return null;/);
    expect(f).toMatch(/if v_distinct > 1 then\s*return null;\s*end if;\s*return v_custom;/);
  });
  it("keeps the 0187 menu rules: positive menu wins, explicit menu 0 is 0, otherwise NULL", () => {
    const f = fn(E);
    expect(f).toMatch(/if v_service_price is not null and v_service_price > 0 then\s*return v_service_price;/);
    expect(f).toMatch(/if v_service_price = 0 then\s*return 0;/);
  });
});

describe("0354: rollback", () => {
  it("restores the 0187 function body byte for byte (modulo comments)", () => {
    expect(fn(DOWN).replace(/\s+/g, " ")).toBe(fn(M0187).replace(/\s+/g, " "));
    expect(DOWN.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
  });
});
