import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0253 — HON-48 F1, decision 14: a non-owner creates, edits and
// deletes blocks only on their OWN schedule; only owners write studio-wide
// blocks or full-day blockouts. SOURCE CONTRACT. Behaviour (every role x
// capacity x action cell, tenants, deactivation) is proved against a real
// database in tests/db/member-scoped-block-authorship.db.test.ts; this file pins
// what a database test cannot see from the inside: the one new EXECUTE grant,
// the revokes Supabase's default privileges would undo, the pinned search_path,
// the explicit behaviour-change statement, and exactly which policies change.
// ===========================================================================

const VERSION = "0253";
const FILE = "0253_member_scoped_block_authorship.sql";
const SQL = readFileSync(path.join(process.cwd(), "supabase/migrations", FILE), "utf8");
// LINE comments first: a comment must never satisfy a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const FN = "public.member_owns_scoped_timed_block(uuid, uuid)";

describe("0253 — migration state", () => {
  it("sits below the repository maximum: the tripwire belongs to the current maximum's own test", () => {
    // Production carried 0254+ above 0253 (it is an out-of-order pending number), so — CLAUDE.md §2 —
    // only the CURRENT maximum's own test asserts isRepoMax.
    expect(isRepoMax(VERSION)).toBe(false);
    expect(versionsAbove(VERSION).length).toBeGreaterThan(0);
  });
  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0253 — header states the behaviour change", () => {
  it("names decision 14 and the capacity-OFF member loss of studio-wide blocking", () => {
    expect(SQL).toMatch(/BEHAVIOUR CHANGE for members of capacity-OFF studios/);
    expect(SQL).toMatch(/item 14/);
    expect(SQL).toMatch(/ONLY OWNERS can write a studio-wide block or a blockout/);
    expect(SQL).toMatch(/studio_blockouts[\s\S]*?NO practitioner column/);
  });
});

describe("0253 — one transaction with a lock timeout", () => {
  it("opens its own begin and arms lock_timeout inside it", () => {
    expect(TOP_LEVEL).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/i);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/i);
  });
});

describe("0253 — the decision function", () => {
  const fn = /create or replace function public\.member_owns_scoped_timed_block\([\s\S]*?\$\$;/i.exec(CODE)?.[0] ?? "";
  it("is a stable SECURITY DEFINER with a pinned search_path and qualified references", () => {
    expect(fn).toMatch(/security definer/i);
    expect(fn).toMatch(/set search_path = pg_catalog, pg_temp/i);
    expect(fn).toMatch(/\bstable\b/i);
    const body = fn.replace(/^[\s\S]*?as \$\$/i, "");
    const relations = [...body.matchAll(/\b(?:from|join)\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(relations.length).toBeGreaterThan(0);
    for (const rel of relations) expect(rel, `unqualified relation ${rel}`).toMatch(/^(public|pg_catalog)\./i);
    expect(body).toMatch(/auth\.uid\(\)/);
  });
  it("is true only for a NON-NULL practitioner that is the caller's own active row in the SAME studio, with capacity ON", () => {
    expect(fn).toMatch(/p_studio_id is not null\s+and p_practitioner_id is not null\s+and public\.studio_capacity_enabled\(p_studio_id\)/i);
    expect(fn).toMatch(/p\.id = p_practitioner_id\s+and p\.studio_id = p_studio_id\s+and p\.user_id = auth\.uid\(\)\s+and p\.active = true/i);
  });
  it("fails closed on any null", () => {
    expect(fn).toMatch(/select coalesce\(/i);
    expect(fn).toMatch(/\),\s*false\s*\)/i);
  });
});

describe("0253 — grants", () => {
  it("revokes EXECUTE from public, anon, authenticated AND service_role by name, then grants authenticated only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE, role).toContain(`revoke execute on function ${FN} from ${role};`);
    }
    expect(CODE.match(/grant execute on function[^;]*;/gi) ?? []).toEqual([`grant execute on function ${FN} to authenticated;`]);
    expect(CODE.indexOf("from service_role;")).toBeLessThan(CODE.indexOf("to authenticated;"));
  });
  it("grants no table privilege", () => {
    expect(TOP_LEVEL).not.toMatch(/grant (select|insert|update|delete|all)/i);
  });
});

describe("0253 — exactly these policies change", () => {
  const policies = [...TOP_LEVEL.matchAll(/create policy "([^"]+)"\s+on public\.([a-z_]+)\s+for ([a-z]+)/gi)].map((m) => `${m[2]}:${m[1]}:${m[3].toLowerCase()}`);
  it("creates the member insert/update/delete policies on timed blocks and select + owner-write on blockouts", () => {
    expect(policies.sort()).toEqual([
      "studio_blockouts:studio_blockouts_member_select:select",
      "studio_blockouts:studio_blockouts_owner_write:all",
      "studio_timed_blocks:studio_timed_blocks_member_delete_own:delete",
      "studio_timed_blocks:studio_timed_blocks_member_insert:insert",
      "studio_timed_blocks:studio_timed_blocks_member_update_own:update",
    ]);
  });
  it("every timed-block member policy goes through the function, and UPDATE has both USING and WITH CHECK", () => {
    expect(TOP_LEVEL).toMatch(/studio_timed_blocks_member_insert"[\s\S]*?with check \(public\.member_owns_scoped_timed_block\(studio_id, practitioner_id\)\);/i);
    expect(TOP_LEVEL).toMatch(/studio_timed_blocks_member_update_own"[\s\S]*?using \(public\.member_owns_scoped_timed_block\(studio_id, practitioner_id\)\)\s+with check \(public\.member_owns_scoped_timed_block\(studio_id, practitioner_id\)\);/i);
    expect(TOP_LEVEL).toMatch(/studio_timed_blocks_member_delete_own"[\s\S]*?using \(public\.member_owns_scoped_timed_block\(studio_id, practitioner_id\)\);/i);
  });
  it("drops the old member_all blockouts policy and creates every policy for authenticated only", () => {
    expect(TOP_LEVEL).toMatch(/drop policy if exists "studio_blockouts_member_all" on public\.studio_blockouts;/i);
    expect((TOP_LEVEL.match(/\n\s+to authenticated\n/gi) ?? []).length).toBe(5);
  });
  it("blockout writes require an OWNER, reads a member", () => {
    expect(TOP_LEVEL).toMatch(/studio_blockouts_owner_write"[\s\S]*?using \(public\.is_studio_owner\(studio_id\)\)\s+with check \(public\.is_studio_owner\(studio_id\)\);/i);
    expect(TOP_LEVEL).toMatch(/studio_blockouts_member_select"[\s\S]*?using \(public\.is_studio_member\(studio_id\)\);/i);
  });
  it("touches no table, trigger or data", () => {
    expect(TOP_LEVEL).not.toMatch(/\b(alter table|create table|create (or replace )?trigger|drop trigger|insert into|update public|delete from|truncate)\b/i);
  });
});
