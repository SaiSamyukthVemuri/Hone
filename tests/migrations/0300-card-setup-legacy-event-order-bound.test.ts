import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// 0300 — PAY-006 legacy-history upper bound. STATIC contract.
//
// Behaviour is proved against a real database in
// tests/db/card-legacy-event-order-bound.db.test.ts. This file pins what a
// behavioural test cannot see: that 0300 changes ONLY 0245's legacy block, keeps
// the signature and grants, writes no row, and that the held rollback restores
// 0245's function body byte-for-byte.

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const M0245 = read("supabase/migrations/0245_ordered_card_setup_success.sql");
const M0300 = read("supabase/migrations/0300_card_setup_legacy_event_order_bound.sql");
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

const LEGACY_START = "  -- Removed history retains its watermark.";
const KNOWN_START = "  select pg_catalog.max(c.stripe_setup_success_event_created) into v_max";

describe("0300 — migration state", () => {
  // A successor (0301, HON-8) is authored, so this is no longer the maximum:
  // isRepoMax(false) + versionsAbove, per CLAUDE.md §2.
  it("is no longer the repository maximum and consumes exactly one number", () => {
    expect(isRepoMax("0300")).toBe(false);
    expect(versionsAbove("0300")).toContain("0301");
    expect(countVersion("0300")).toBe(1);
  });
});

describe("0300 — shape", () => {
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const e = exec(M0300).trim();
    expect(e.startsWith("begin;")).toBe(true);
    expect(e).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(e.endsWith("commit;")).toBe(true);
  });

  it("replaces the function with the SAME signature (deployed app needs no change)", () => {
    const sig = (sql: string) => fnFromParams(sql).split("returns table")[0];
    expect(sig(M0300)).toBe(sig(M0245));
    expect(M0300).toMatch(/create or replace function public\.save_client_card_on_file_ordered\(/);
  });

  it("changes nothing outside the legacy block: the head and the known-evidence tail are 0245's bytes", () => {
    const old = fnFromParams(M0245);
    const neu = fnFromParams(M0300);
    // Head (minus the declare block, which only ADDS variables) and tail.
    const tail = (s: string) => s.slice(s.indexOf(KNOWN_START));
    const head = (s: string) => s.slice(s.indexOf("begin\n  if p_studio_id is null"), s.indexOf(LEGACY_START));
    expect(tail(neu)).toBe(tail(old));
    expect(head(neu)).toBe(head(old));
    for (const v of ["v_existing public.client_payment_methods%rowtype;", "v_max bigint;", "v_saved record;"]) {
      expect(neu).toContain(v);
    }
  });

  it("bounds legacy rows by ceil(epoch(created_at)) + a 900 s margin, 'portal' rows only, refusing at the bound", () => {
    const e = exec(fnFromParams(M0300));
    expect(e).toContain("c_legacy_margin_seconds constant bigint := 900;");
    expect(e).toMatch(/pg_catalog\.ceil\(pg_catalog\.max\(extract\(epoch from c\.created_at\)\)\)::bigint\s*\+ c_legacy_margin_seconds/);
    expect(e).toContain("c.stripe_setup_success_event_created is null;");
    expect(e).toContain("filter (where c.added_via is distinct from 'portal')");
    expect(e).toContain("p_success_event_created <= v_legacy_bound");
    expect(e).toContain("v_existing.stripe_setup_success_event_created is null");
  });

  it("writes no row outside the function: no backfill, no evidence adoption", () => {
    const e = exec(M0300);
    const outside = e.replace(fnFromParams(e), "");
    expect(outside.length).toBeLessThan(e.length - 1000); // the function really was cut out
    expect(outside).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(outside).not.toMatch(/alter table/i);
  });

  it("restates 0245's closure by name: revoke from public, anon, authenticated, service_role; grant service_role", () => {
    const e = exec(M0300);
    const A = "uuid, uuid, text, boolean, text, text, text, text, text, integer, integer, uuid";
    expect(e).toContain(`revoke execute on function public.save_client_card_on_file(\n  ${A}\n) from public, anon, authenticated, service_role;`);
    expect(e).toContain(`revoke execute on function public.save_client_card_on_file_ordered(\n  ${A}, text, bigint\n) from public, anon, authenticated, service_role;`);
    expect(e).toContain(`grant execute on function public.save_client_card_on_file_ordered(\n  ${A}, text, bigint\n) to service_role;`);
    expect((e.match(/\bgrant\b/gi) ?? []).length).toBe(1);
  });
});

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
