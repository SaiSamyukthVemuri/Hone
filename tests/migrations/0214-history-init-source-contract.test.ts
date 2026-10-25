import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// T-0214-1 (R-2(c1)) source contract: initialize_studio_payment_jurisdiction_from_history.
//
// Reads 0214 by default. Until P-2 permits the 0214 edit, the validation run
// points T0214_SQL_SOURCE at the assembled amended 0214
// (general/T0214-1-AMENDED/0214_studio_payment_jurisdiction.sql) instead.
// Plan: general/F1-TESTMODE-DESIGN-NOTE.md group G (and H5).

const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS = path.join(ROOT, "supabase/migrations");
const SOURCE = process.env.T0214_SQL_SOURCE
  ?? path.join(MIGRATIONS, "0214_studio_payment_jurisdiction.sql");
const SQL = readFileSync(SOURCE, "utf8");
const CODE = SQL.replace(/--[^\n]*/g, "");

const COMMAND = "initialize_studio_payment_jurisdiction_from_history(uuid, text, text, text, text, text, boolean, text[], uuid[])";
const HELPERS = [
  "studio_account_acceptable_for_jurisdiction(uuid, text, boolean, text, boolean)",
  "studio_named_stripe_accounts(uuid)",
];
const ROLES = ["public", "anon", "authenticated", "service_role"];
const EXEMPT = ["stripe_events"];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const body = (fn: string) => {
  const at = CODE.indexOf(`create or replace function public.${fn}(`);
  expect(at, fn).toBeGreaterThanOrEqual(0);
  const start = CODE.indexOf("$$", at);
  return CODE.slice(start, CODE.indexOf("$$", start + 2));
};

describe("G1 privileges are revoked by name, then granted to service_role only", () => {
  for (const fn of [COMMAND, ...HELPERS]) {
    it(`${fn.split("(")[0]}: four revokes by name`, () => {
      for (const role of ROLES) {
        expect(CODE, `${fn} from ${role}`).toMatch(
          new RegExp(`revoke execute on function public\\.${esc(fn)} from ${role};`),
        );
      }
    });
  }

  it("only the command is granted, and only to service_role", () => {
    const grants = [...CODE.matchAll(/grant execute on function public\.(\w+)\(([^)]*)\) to (\w+);/g)]
      .filter((m) => [COMMAND, ...HELPERS].some((f) => f.startsWith(`${m[1]}(`)));
    expect(grants.map((m) => `${m[1]}(${m[2]}) to ${m[3]}`)).toEqual([`${COMMAND} to service_role`]);
  });
});

describe("P1 placement inside 0214 (Willow F-1)", () => {
  // studio_account_acceptable_for_jurisdiction is LANGUAGE sql: Postgres
  // parse-analyses its body at CREATE time, so it must come after 4b adds the
  // studio_payment_settings columns it reads, or the 0214 transaction aborts.
  // Needs the whole 0214 (the amended file), not the bare draft fragment.
  it("the SQL helper is created after 4b adds stripe_account_country and its conflict column", () => {
    const helper = CODE.indexOf("create or replace function public.studio_account_acceptable_for_jurisdiction(");
    expect(helper).toBeGreaterThanOrEqual(0);
    for (const col of ["stripe_account_country text", "stripe_account_country_conflict text"]) {
      const added = CODE.indexOf(`add column if not exists ${col}`);
      expect(added, col).toBeGreaterThanOrEqual(0);
      expect(helper, col).toBeGreaterThan(added);
    }
  });
});

describe("H5/F4 lock order", () => {
  it("studio NO KEY UPDATE, jurisdiction FOR UPDATE, settings SHARE, studio FOR UPDATE, settings SHARE again", () => {
    const b = body("initialize_studio_payment_jurisdiction_from_history");
    const steps = [
      /from public\.studios st where st\.id = p_studio_id for no key update/,
      /from public\.studio_payment_jurisdictions j\s+where j\.studio_id = p_studio_id\s+for update/,
      /from public\.studio_payment_settings s\s+where s\.studio_id = p_studio_id for share/,
      /from public\.studios st where st\.id = p_studio_id for update/,
      /from public\.studio_payment_settings s\s+where s\.studio_id = p_studio_id for share/,
    ];
    let from = 0;
    for (const [i, re] of steps.entries()) {
      const m = re.exec(b.slice(from));
      expect(m, `lock step ${i + 1}`).not.toBeNull();
      from += m!.index + m![0].length;
    }
    // The money checks come only after the last lock.
    expect(b.indexOf("refused_unlisted_money_table")).toBeGreaterThan(from);
  });
});

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

  it("the runtime check refuses on an unlisted money-shaped table", () => {
    const b = body("initialize_studio_payment_jurisdiction_from_history");
    expect(b).toMatch(/not \(c\.relname::text = any \(c_money_universe\)\)/);
    expect(b).toMatch(/a\.attname in \('currency', 'stripe_account_id'\)/);
    expect(b).toMatch(/like '%\\_cents' escape '\\'/);
  });
});
