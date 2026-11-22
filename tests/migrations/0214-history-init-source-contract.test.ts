import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// 0214 pins the universe of money-shaped tables that
// initialize_studio_payment_jurisdiction_from_history checks. 0214 is applied
// and frozen, so a later migration that adds a money-shaped table makes G2
// fail until a new migration extends the universe. G3 holds the EXEMPT list
// that tests/migrations/exemption-db-pairing.test.ts uses as its discovery anchor.

const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const SOURCE = process.env.T0214_SQL_SOURCE
  ?? path.join(MIGRATIONS, "0214_studio_payment_jurisdiction.sql");
const SQL = readFileSync(SOURCE, "utf8");
const CODE = SQL.replace(/--[^\n]*/g, "");

// exemption-db-pair: tests/db/studio-payment-jurisdiction-history-init.db.test.ts | initialize_studio_payment_jurisdiction_from_history | stripe_events
const EXEMPT = ["stripe_events"];
const body = (fn: string) => {
  const at = CODE.indexOf(`create or replace function public.${fn}(`);
  expect(at, fn).toBeGreaterThanOrEqual(0);
  const start = CODE.indexOf("$$", at);
  return CODE.slice(start, CODE.indexOf("$$", start + 2));
};

describe("G2/G3 the money-table universe is pinned (F5)", () => {
  /** Every table any migration creates with a currency, stripe_account_id or *_cents column, minus drops. */
  function derived(): string[] {
    const cols = new Map<string, Set<string>>();
    const add = (t: string, c: string) => { if (!cols.has(t)) cols.set(t, new Set()); cols.get(t)!.add(c); };
    for (const f of readdirSync(MIGRATIONS).filter((n) => n.endsWith(".sql")).sort()) {
      const s = readFileSync(path.join(MIGRATIONS, f), "utf8").replace(/--[^\n]*/g, "");
      for (const m of s.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
        for (const c of m[2].matchAll(/^\s*(\w+)\s+(?:text|integer|bigint|numeric|uuid|boolean|int|smallint)/gm)) add(m[1], c[1]);
      }
      for (const m of s.matchAll(/alter table (?:if exists )?public\.(\w+)([\s\S]*?);/g)) {
        for (const c of m[2].matchAll(/add column (?:if not exists )?(\w+)/g)) add(m[1], c[1]);
      }
      for (const m of s.matchAll(/drop table (?:if exists )?public\.(\w+)/g)) cols.delete(m[1]);
    }
    return [...cols].filter(([, cs]) => [...cs].some((c) => c === "currency" || c === "stripe_account_id" || c.endsWith("_cents")))
      .map(([t]) => t).sort();
  }
  const pinned = () => {
    const m = /c_money_universe constant text\[\] := array\[([\s\S]*?)\];/.exec(CODE);
    expect(m, "c_money_universe").not.toBeNull();
    return [...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1]).sort();
  };

  it("G2 the pinned universe equals the tables the migrations define", () => {
    expect(pinned()).toEqual(derived());
  });

  it("G3 every pinned table is checked by the command or its helper, or is a named exemption", () => {
    const checked = body("initialize_studio_payment_jurisdiction_from_history") + body("studio_named_stripe_accounts");
    for (const t of pinned()) {
      if (EXEMPT.includes(t)) continue;
      expect(checked, t).toMatch(new RegExp(`public\\.${t}\\b`));
    }
  });
});
