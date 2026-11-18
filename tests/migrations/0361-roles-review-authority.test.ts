import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRepoMax } from "./helpers/migration-state";

// 0361 source contract: function-only; the internal body equals the 0360 body apart from the declared lines; the rollback restores the sealed 0360
// body and drops each new function by exact signature; every new function is revoked by name from four roles; no RAISE carries the table.

const UP = readFileSync("supabase/migrations/0361_roles_review_authority.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0361_roles_review_authority.down.sql", "utf8");
const PREV = readFileSync("supabase/migrations/0360_roles_save_inert_denial.sql", "utf8");
const SEALED_0360_BODY_MD5 = "e1f64999b3fda06d586261447acbaca0"; // prosrc of perm_run_changes after 0360 (recorded in the 0360 PR)

const bodyOf = (sql: string, name: string) => {
  const from = sql.indexOf(`create or replace function public.${name}(`);
  expect(from, name).toBeGreaterThan(-1);
  const open = sql.indexOf("as $$", from) + "as $$".length;
  return sql.slice(open, sql.indexOf("$$;", open));
};
const headOf = (sql: string, name: string) => {
  const from = sql.indexOf(`create or replace function public.${name}(`);
  return sql.slice(from, sql.indexOf("as $$", from));
};
const NEW_FUNCTIONS: [string, string][] = [
  ["perm_review_involved", "text[]"],
  ["perm_review_timing", "boolean, text, text, text, text, text, boolean, boolean"],
  ["perm_review_hash_input", "uuid, bigint, jsonb, jsonb, boolean, jsonb"],
  ["perm_review_hash", "uuid, bigint, jsonb, jsonb, boolean, jsonb"],
  ["perm_run_changes_reviewed", "uuid, jsonb, text, boolean, bigint, boolean, boolean, text"],
  ["preview_role_changes_at", "uuid, jsonb, bigint"],
  ["save_role_permissions_reviewed", "uuid, bigint, jsonb, text, boolean, text"],
];

describe("0361 source contract", () => {
  it("is the current maximum migration (only the max may assert this)", () => {
    expect(isRepoMax("0361")).toBe(true);
  });

  it("opens its own transaction with a lock timeout inside it, and is function-only", () => {
    expect(UP).toMatch(/^begin;\s*\nset local lock_timeout = '5s';/m);
    expect(UP.trimEnd().endsWith("commit;")).toBe(true);
    expect(UP).not.toMatch(/\b(create|alter|drop)\s+(table|index|trigger|policy|type)\b/i);
    // the only table write is the internal function's, copied from 0360 (a single insert into studio_role_permissions plus the audit insert)
    expect((UP.match(/insert\s+into\s+public\.(\w+)/gi) ?? []).map((s) => s.replace(/\s+/g, " ").toLowerCase()).sort()).toEqual(
      ["insert into public.permission_audit", "insert into public.studio_permission_policy", "insert into public.studio_permission_policy", "insert into public.studio_role_permissions"].sort(),
    );
    expect(UP).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("the 0360 body hashes to the sealed value, and the rollback restores it byte for byte", () => {
    expect(createHash("md5").update(bodyOf(PREV, "perm_run_changes")).digest("hex")).toBe(SEALED_0360_BODY_MD5);
    expect(createHash("md5").update(bodyOf(DOWN, "perm_run_changes")).digest("hex")).toBe(SEALED_0360_BODY_MD5);
    expect(headOf(DOWN, "perm_run_changes")).toBe(headOf(PREV, "perm_run_changes"));
  });

  it("the delegator keeps the exact 0360 head", () => {
    expect(headOf(UP, "perm_run_changes")).toBe(headOf(PREV, "perm_run_changes"));
  });

  it("the internal body equals the 0360 body apart from the declared lines (additive)", () => {
    const prev = bodyOf(PREV, "perm_run_changes").split("\n");
    const next = bodyOf(UP, "perm_run_changes_reviewed").split("\n");
    const prevSet = new Set(prev.map((l) => l.trim()));
    const removed = prev.filter((l) => !next.map((n) => n.trim()).includes(l.trim()));
    // exactly two 0360 lines are rewritten: the apply condition (now `if v_applies then`, with v_applies computed from the SAME expression) and the result's last line
    expect(removed.map((l) => l.trim())).toEqual([
      "if v_scope <> v_base or (v_stored_prev is not null and v_stored_prev <> v_scope) or v_scope <> v_shown then",
      "'reason_required', v_widen, 'sensitive_keys', v_sens",
    ]);
    expect(next.join("\n")).toContain("v_applies := v_scope <> v_base or (v_stored_prev is not null and v_stored_prev <> v_scope) or v_scope <> v_shown;");
    // every added line is part of the declared list (declarations, rows, review table, hash compare, result keys, audit stamp)
    const added = next.filter((l) => !prevSet.has(l.trim())).join("\n");
    for (const must of ["v_applies", "v_rows", "v_review", "v_hash", "review_changed", "'review_hash', v_hash", "'_review'"]) expect(added).toContain(must);
    expect(added).not.toMatch(/\bnow\(\)|clock_timestamp|random\(|gen_random_uuid/);
  });

  it("every new function is SECURITY DEFINER or immutable-pure, with an empty search_path", () => {
    for (const [name] of NEW_FUNCTIONS) {
      const head = headOf(UP, name);
      expect(head, name).toMatch(/set search_path = ''/);
      if (name !== "perm_review_timing") expect(head, name).toMatch(/security definer/);
    }
  });

  it("every new function is revoked by name from public, anon, authenticated and service_role; only the two commands are granted, to authenticated", () => {
    for (const [name, args] of NEW_FUNCTIONS) {
      expect(UP, name).toContain(`revoke all on function public.${name}(${args}) from public, anon, authenticated, service_role;`);
    }
    const grants = [...UP.matchAll(/grant execute on function public\.(\w+)\(([^)]*)\) to (\w+);/g)].map((m) => `${m[1]}->${m[3]}`);
    expect(grants.sort()).toEqual(["preview_role_changes_at->authenticated", "save_role_permissions_reviewed->authenticated"]);
  });

  it("the rollback restores the body first, then drops each new function by its exact signature", () => {
    const restoreAt = DOWN.indexOf("create or replace function public.perm_run_changes(");
    expect(restoreAt).toBeGreaterThan(-1);
    for (const [name, args] of NEW_FUNCTIONS) {
      const at = DOWN.indexOf(`drop function public.${name}(${args});`);
      expect(at, name).toBeGreaterThan(restoreAt);
    }
    expect(DOWN).toMatch(/^begin;\s*\nset local lock_timeout = '5s';/m);
  });

  it("no RAISE message carries the review table, the hash or a changes payload (L2): every raise is a perm_fail code", () => {
    const raises = [...UP.matchAll(/raise exception[^;]*;/g)].map((m) => m[0]);
    expect(raises.length).toBeGreaterThan(0);
    for (const r of raises) {
      expect(r).toMatch(/message = public\.perm_fail\(|message = 'preview'|using errcode = 'PM00[12]'/);
      expect(r).not.toMatch(/v_review|v_hash|p_review_hash|v_rows|p_changes/);
    }
  });

  it("the file says what a refused save leaves behind (the default policy row) and names no review id", () => {
    expect(UP).toContain("WHAT A REFUSAL LEAVES BEHIND");
    expect(UP).not.toMatch(/Codex|final\d+|\b45\d{8}\b/);
  });

  it("every raise in the file is a coded refusal (errcode), never a bare P0001 that escapes the caller's handler", () => {
    for (const m of UP.matchAll(/raise exception[^;]*;/g)) expect(m[0], m[0]).toMatch(/using errcode = 'PM00[12]'/);
  });

  it("the involved keys run in BOTH directions (dependents and what caps them) and the hash covers the complete effective diff", () => {
    const fn = UP.slice(UP.indexOf("create or replace function public.perm_review_involved("), UP.indexOf("-- When a saved choice takes effect"));
    expect(fn).toContain("join dependents d on d.key = any (c.requires)"); // keys that require a requested key, transitively
    expect(fn).toContain("select unnest(c.requires) from public.permission_catalog c join involved i on c.key = i.key"); // and what any of them require
    expect(UP).toMatch(/v_hash := public\.perm_review_hash\(p_studio, v_version, v_review, v_sens, v_widen, v_changes\);/);
    expect(UP).toContain("'changes', (select coalesce(jsonb_agg(jsonb_build_object('role', r.role, 'key', d.value ->> 'key', 'before', d.value ->> 'before', 'after', d.value ->> 'after')");
    expect(UP).toContain('order by r.role collate "C", d.value ->> \'key\' collate "C"');
    expect(UP).not.toMatch(/'changes'[^;]*consequence/); // never the catalog's free text
  });

  it("`changes` and its rows are never placed in a raise, a message, or any returned text", () => {
    for (const m of UP.matchAll(/raise exception[^;]*;/g)) expect(m[0], m[0]).not.toMatch(/v_changes|p_changes|changes/);
    expect(UP).not.toMatch(/perm_fail\([^;]*v_changes/);
  });

  it("the hash input has a fixed, documented field list and a comment that additions need review", () => {
    expect(UP).toContain("PRIVACY: this is the covered field list; adding a name, a reason or any free text needs review.");
    expect(UP).toContain("Fields: v, studio, version, basis, basis_at, review, changes, sensitive_keys, reason_required, releases, activations, catalog, gates.");
  });
});
