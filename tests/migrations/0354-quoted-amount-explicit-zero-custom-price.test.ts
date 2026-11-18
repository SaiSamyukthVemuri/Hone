import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0354: rollback file contract. Behaviour (and agreement with the TypeScript resolver) is proved against a real database in
// tests/db/appointment-quoted-amount-parity.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0354_quoted_amount_explicit_zero_custom_price";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));
const M0187 = exec(readFileSync(join(root, "supabase/migrations/0187_appointment_settlement.sql"), "utf8"));
const fn = (sql: string) => {
  const a = sql.indexOf("create or replace function public.appointment_quoted_amount_cents");
  return sql.slice(a, sql.indexOf("$$;", sql.indexOf("as $$", a)) + 3);
};

describe("0354: rollback", () => {
  it("restores the 0187 function body byte for byte (modulo comments)", () => {
    expect(fn(DOWN).replace(/\s+/g, " ")).toBe(fn(M0187).replace(/\s+/g, " "));
    expect(DOWN.trim()).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
  });
});
