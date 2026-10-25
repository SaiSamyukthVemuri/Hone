import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0253 — HON-48 F1: a non-owner blocks only THEIR OWN schedule.
// SOURCE CONTRACT. Behaviour (who may insert what, per role and tenant, with
// capacity ON and OFF) is proved against a real database in
// tests/db/member-scoped-timed-block-insert.db.test.ts; this file pins what a
// database test cannot see from the inside: the one new EXECUTE grant, the
// revokes Supabase's default privileges would undo, the pinned search_path, and
// that nothing but the member INSERT policy changed.
// ===========================================================================

const VERSION = "0253";
const FILE = "0253_member_scoped_timed_block_insert.sql";
const SQL = readFileSync(path.join(process.cwd(), "supabase/migrations", FILE), "utf8");
// LINE comments first: a comment must never satisfy a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const FN = "public.member_may_insert_timed_block(uuid, uuid)";

describe("0253 — migration state", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — CLAUDE.md §2.
    expect(isRepoMax(VERSION), "0253 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0253").toEqual([]);
  });
  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0253 — one transaction with a lock timeout", () => {
  it("opens its own begin and arms lock_timeout inside it", () => {
    expect(TOP_LEVEL).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/i);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/i);
  });
});

describe("0253 — the decision function", () => {
  const fn = /create or replace function public\.member_may_insert_timed_block\([\s\S]*?\$\$;/i.exec(CODE)?.[0] ?? "";
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
  it("studio-wide rows need membership AND capacity OFF; scoped rows need capacity ON AND the caller's own active practitioner row in the SAME studio", () => {
    expect(fn).toMatch(/p_practitioner_id is null then\s+public\.is_studio_member\(p_studio_id\)\s+and not public\.studio_capacity_enabled\(p_studio_id\)/i);
    expect(fn).toMatch(/else\s+public\.studio_capacity_enabled\(p_studio_id\)\s+and exists \(/i);
    expect(fn).toMatch(/p\.id = p_practitioner_id\s+and p\.studio_id = p_studio_id\s+and p\.user_id = auth\.uid\(\)\s+and p\.active = true/i);
  });
  it("fails closed on a null studio or a null result", () => {
    expect(fn).toMatch(/when p_studio_id is null then false/i);
    expect(fn).toMatch(/select coalesce\(/i);
    expect(fn).toMatch(/\bend,\s*false\s*\)/i);
  });
});

describe("0253 — grants", () => {
  it("revokes EXECUTE from public, anon, authenticated AND service_role by name, then grants authenticated only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE, role).toContain(`revoke execute on function ${FN} from ${role};`);
    }
    const grants = CODE.match(/grant execute on function[^;]*;/gi) ?? [];
    expect(grants).toEqual([`grant execute on function ${FN} to authenticated;`]);
    expect(CODE.indexOf("from service_role;")).toBeLessThan(CODE.indexOf("to authenticated;"));
  });
});

describe("0253 — only the member INSERT policy is replaced", () => {
  it("drops and recreates exactly studio_timed_blocks_member_insert, INSERT to authenticated, through the function", () => {
    expect(TOP_LEVEL.match(/drop policy/gi)).toHaveLength(1);
    expect(TOP_LEVEL.match(/create policy/gi)).toHaveLength(1);
    expect(TOP_LEVEL).toMatch(
      /drop policy if exists "studio_timed_blocks_member_insert" on public\.studio_timed_blocks;\s*create policy "studio_timed_blocks_member_insert"\s+on public\.studio_timed_blocks\s+for insert\s+to authenticated\s+with check \(public\.member_may_insert_timed_block\(studio_id, practitioner_id\)\);/i,
    );
  });
  it("touches no table, trigger or data, and grants no write privilege", () => {
    expect(TOP_LEVEL).not.toMatch(/\b(alter table|create table|create (or replace )?trigger|drop trigger|insert into|update public|delete from|truncate)\b/i);
    expect(TOP_LEVEL).not.toMatch(/grant (insert|update|delete|all)/i);
  });
});
