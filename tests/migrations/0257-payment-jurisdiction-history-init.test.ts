import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 0257: the R-2(c1) follow-up to the UNAMENDED 0214. Source contract only; the
// behaviour is proved by tests/db/studio-payment-jurisdiction-history-init.db.test.ts
// (J9-A..J9-H) against a real chain.

const ROOT = path.resolve(__dirname, "../..");
const FILE = path.join(ROOT, "supabase/migrations/0257_payment_jurisdiction_history_init.sql");
const SQL = readFileSync(FILE, "utf8");
const CODE = SQL.replace(/--[^\n]*/g, "");

const MARK = "-- ---------------------------------------------------------------------------\n-- 3b. Initialization";
// sha256 of everything from the 3b banner to the line before the closing commit:
// the T-0214-1 text of the amended 0214, reused rather than redesigned.
const REUSED_BLOCK_SHA256 = "2a38e1d5a401d8220de11d5ffc9c84bc6ce2aba04d27659a8c9ecb8f933ae37d";

describe("0257 shape", () => {
  it("opens its own transaction, arms lock_timeout inside it, and commits once", () => {
    expect(CODE.match(/^begin;$/gm)?.length).toBe(1);
    expect(CODE.match(/^commit;$/gm)?.length).toBe(1);
    expect(CODE.indexOf("begin;")).toBeLessThan(CODE.indexOf("set local lock_timeout = '5s';"));
    expect(CODE.indexOf("set local lock_timeout = '5s';")).toBeLessThan(CODE.indexOf("alter table"));
  });

  it("adds exactly the three audit columns, idempotently, with metadata-only defaults", () => {
    const alters = [...CODE.matchAll(/alter table ([\w.]+)\s+([\s\S]*?);/g)];
    expect(alters).toHaveLength(1);
    expect(alters[0][1]).toBe("public.studio_payment_jurisdiction_changes");
    expect(alters[0][2].split(",").map((c) => c.trim().replace(/\s+/g, " "))).toEqual([
      "add column if not exists history_verified boolean not null default false",
      "add column if not exists unobserved_test_accounts_acknowledged text[] not null default '{}'",
      "add column if not exists unbound_test_attempts_acknowledged uuid[] not null default '{}'",
    ]);
  });

  it("adds no table, trigger, policy, index, or data change outside function bodies", () => {
    const outside = CODE.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
    for (const re of [
      /create\s+(?:unique\s+)?(?:table|index|trigger|policy|view|type|extension)/i,
      /drop\s+(?:table|column|trigger|policy|function)/i,
      /\binsert\s+into\b/i,
      /\bupdate\s+public\./i,
      /\bdelete\s+from\b/i,
      /alter\s+table[\s\S]*?(?:drop|alter\s+column|rename)/i,
      /create\s+or\s+replace\s+function\s+public\.(?!studio_account_acceptable_for_jurisdiction|studio_named_stripe_accounts|initialize_studio_payment_jurisdiction_from_history)/i,
    ]) {
      expect(outside, String(re)).not.toMatch(re);
    }
  });

  it("creates exactly the three T-0214-1 functions", () => {
    expect([...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]).sort()).toEqual([
      "initialize_studio_payment_jurisdiction_from_history",
      "studio_account_acceptable_for_jurisdiction",
      "studio_named_stripe_accounts",
    ]);
  });

  it("the reused T-0214-1 block is unchanged (checksum pin)", () => {
    const at = SQL.indexOf(MARK);
    expect(at).toBeGreaterThan(0);
    const end = SQL.lastIndexOf("\ncommit;\n");
    const block = SQL.slice(at, end);
    expect(createHash("sha256").update(block).digest("hex")).toBe(REUSED_BLOCK_SHA256);
  });
});
