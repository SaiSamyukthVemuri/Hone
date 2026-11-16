import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isRepoMax } from "./helpers/migration-state";

// 0356 source contract: function-only; the internal body equals the 0355 body apart from the declared lines; the rollback restores the sealed 0355
// body and drops each new function by exact signature; every new function is revoked by name from four roles; no RAISE carries the table.

const UP = readFileSync("supabase/migrations/0356_roles_review_authority.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0356_roles_review_authority.down.sql", "utf8");
const PREV = readFileSync("supabase/migrations/0355_roles_save_inert_denial.sql", "utf8");
const SEALED_0355_BODY_MD5 = "4e65b638a84cfba3d24c1fc44b34daa0"; // prosrc of perm_run_changes after 0355 (recorded in the 0355 PR)

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
  ["perm_review_hash_input", "uuid, bigint, jsonb, jsonb, boolean"],
  ["perm_review_hash", "uuid, bigint, jsonb, jsonb, boolean"],
  ["perm_run_changes_reviewed", "uuid, jsonb, text, boolean, bigint, boolean, boolean, text"],
  ["preview_role_changes_at", "uuid, jsonb, bigint"],
  ["save_role_permissions_reviewed", "uuid, bigint, jsonb, text, boolean, text"],
];

describe("0356 source contract", () => {
  it("is the current maximum migration (only the max may assert this)", () => {
    expect(isRepoMax("0356")).toBe(true);
  });

  it("opens its own transaction with a lock timeout inside it, and is function-only", () => {
    expect(UP).toMatch(/^begin;\s*\nset local lock_timeout = '5s';/m);
    expect(UP.trimEnd().endsWith("commit;")).toBe(true);
    expect(UP).not.toMatch(/\b(create|alter|drop)\s+(table|index|trigger|policy|type)\b/i);
    // the only table write is the internal function's, copied from 0355 (a single insert into studio_role_permissions plus the audit insert)
    expect((UP.match(/insert\s+into\s+public\.(\w+)/gi) ?? []).map((s) => s.replace(/\s+/g, " ").toLowerCase()).sort()).toEqual(
      ["insert into public.permission_audit", "insert into public.studio_permission_policy", "insert into public.studio_permission_policy", "insert into public.studio_role_permissions"].sort(),
    );
    expect(UP).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("the 0355 body hashes to the sealed value, and the rollback restores it byte for byte", () => {
    expect(createHash("md5").update(bodyOf(PREV, "perm_run_changes")).digest("hex")).toBe(SEALED_0355_BODY_MD5);
    expect(createHash("md5").update(bodyOf(DOWN, "perm_run_changes")).digest("hex")).toBe(SEALED_0355_BODY_MD5);
    expect(headOf(DOWN, "perm_run_changes")).toBe(headOf(PREV, "perm_run_changes"));
  });

  it("the delegator keeps the exact 0355 head", () => {
    expect(headOf(UP, "perm_run_changes")).toBe(headOf(PREV, "perm_run_changes"));
  });

  it("the internal body equals the 0355 body apart from the declared lines (additive)", () => {
    const prev = bodyOf(PREV, "perm_run_changes").split("\n");
    const next = bodyOf(UP, "perm_run_changes_reviewed").split("\n");
    const prevSet = new Set(prev.map((l) => l.trim()));
    const removed = prev.filter((l) => !next.map((n) => n.trim()).includes(l.trim()));
    // exactly two 0355 lines are rewritten: the apply condition (now `if v_applies then`, with v_applies computed from the SAME expression) and the result's last line
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
      // the one fixed-text exception: the timing function's refusal of a state it has no label for (no data in it)
      expect(r).toMatch(/message = public\.perm_fail\(|message = 'preview'|using errcode = 'PM00[12]'|^raise exception 'perm_review_timing: no label for this state';$/);
      expect(r).not.toMatch(/v_review|v_hash|p_review_hash|v_rows|p_changes/);
    }
  });

  it("the hash input has a fixed, documented field list (Privacy H5) and a comment that additions need review", () => {
    expect(UP).toContain("PRIVACY: this is the covered field list; adding a name, a reason or any free text needs review.");
    expect(UP).toContain("Fields: v, studio, version, basis, basis_at, review, sensitive_keys, reason_required, releases, activations, catalog, gates.");
  });
});
