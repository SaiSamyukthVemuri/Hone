import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// 0300 — PAY-006 legacy-history upper bound. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/card-legacy-event-order-bound.db.test.ts. This file pins that the
// held rollback restores 0245's function body byte-for-byte.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const M0245 = read("supabase/migrations/0245_ordered_card_setup_success.sql");
const ROLLBACK_PATH = "supabase/rollbacks/0300_card_setup_legacy_event_order_bound.down.sql";
const ROLLBACK = read(ROLLBACK_PATH);

const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");

/** Text from the function name's opening parenthesis through the closing $$; */
function fnFromParams(sql: string): string {
  const start = sql.indexOf("function public.save_client_card_on_file_ordered(");
  expect(start).toBeGreaterThanOrEqual(0);
  const end = sql.indexOf("\n$$;", start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end + "\n$$;".length);
}

describe("0300 — held rollback", () => {
  it("lives outside supabase/migrations, so no apply can pick it up", () => {
    expect(existsSync(join(ROOT, "supabase/migrations/0300_card_setup_legacy_event_order_bound.down.sql"))).toBe(false);
    expect(ROLLBACK_PATH.startsWith("supabase/migrations/")).toBe(false);
  });

  it("restores 0245's function body BYTE-FOR-BYTE", () => {
    expect(fnFromParams(ROLLBACK)).toBe(fnFromParams(M0245));
  });

  it("is itself a well-formed forward migration with 0245's grants", () => {
    const e = exec(ROLLBACK).trim();
    expect(e).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(e.endsWith("commit;")).toBe(true);
    expect(e).toContain("create or replace function public.save_client_card_on_file_ordered(");
    const grants0245 = M0245.slice(M0245.indexOf("revoke execute on function public.save_client_card_on_file_ordered("), M0245.lastIndexOf("commit;"));
    expect(ROLLBACK).toContain(grants0245.trim());
  });
});
