import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0349 source contract. Behaviour is proved against a database in tests/db/pinned-note-edit-key-gate-0349.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0349")}`, "utf8");
const down = () => readFileSync(`supabase/rollbacks/${fileForVersion("0349").replace(/\.sql$/, ".down.sql")}`, "utf8");
const m0254 = () => readFileSync(`supabase/migrations/${fileForVersion("0254")}`, "utf8");
const code = (t: string) => t.replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const fnBody = (t: string, head: RegExp) => {
  const m = t.match(head);
  expect(m).not.toBeNull();
  return m![0];
};

describe("0349 pinned-note edit: requires the allergies-and-cautions edit permission (source)", () => {
  it("exists exactly once", () => {
    expect(countVersion("0349")).toBe(1);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code(sql());
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });

  it("replaces exactly one function and changes no table, policy, trigger, grant or data", () => {
    const c = code(sql());
    expect((c.match(/create or replace function/gi) ?? []).length).toBe(1);
    expect(c).not.toMatch(/(^|;)\s*(grant|revoke|drop|truncate|delete|insert\s+into\s+public\.client)/gim);
    expect(c).not.toMatch(/alter\s+(table|policy)|create\s+(policy|trigger|table)/i);
  });

  it("is the 0254 function with exactly one added check and nothing else different", () => {
    const old = fnBody(code(m0254()), /create function public\.edit_client_pinned_note\([\s\S]*?\n\$\$;/);
    const neu = fnBody(code(sql()), /create or replace function public\.edit_client_pinned_note\([\s\S]*?\n\$\$;/);
    const check = /\n  if not public\.has_studio_permission\(p_studio_id, 'client\.edit_allergies_cautions', p_client_id\) then\n    return false;\n  end if;\n/;
    expect(neu).toMatch(check);
    expect(norm(neu.replace(check, "\n").replace("create or replace function", "create function"))).toBe(norm(old));
  });

  it("the check comes after the caller is resolved and before any write", () => {
    const neu = fnBody(code(sql()), /create or replace function public\.edit_client_pinned_note\([\s\S]*?\n\$\$;/);
    const at = neu.indexOf("has_studio_permission");
    expect(at).toBeGreaterThan(neu.indexOf("v_actor is null"));
    expect(at).toBeLessThan(neu.indexOf("update public.client_pinned_notes"));
  });

  it("refuses to apply when the key row is missing, authenticated cannot run the engine, or the function posture drifted", () => {
    const c = norm(code(sql()));
    expect(c).toContain("from public.permission_catalog where key = 'client.edit_allergies_cautions'");
    expect(c).toContain("has_function_privilege('authenticated', 'public.has_studio_permission(uuid,text,uuid,uuid,uuid)', 'EXECUTE')");
    expect(c).toContain("is not SECURITY DEFINER with a fixed search_path");
    expect(c).toContain("must be executable by authenticated only");
  });

  it("is marked not applied; the down file restores the 0254 body with no permission check", () => {
    expect(sql()).toMatch(/NOT APPLIED/);
    const d = fnBody(code(down()), /create or replace function public\.edit_client_pinned_note\([\s\S]*?\n\$\$;/);
    const old = fnBody(code(m0254()), /create function public\.edit_client_pinned_note\([\s\S]*?\n\$\$;/);
    expect(norm(d.replace("create or replace function", "create function"))).toBe(norm(old));
    expect(d).not.toMatch(/has_studio_permission/);
    expect(down()).toMatch(/begin;/);
    expect(down()).toMatch(/commit;/);
  });

  it("states the rule without naming a route or internal identifier", () => {
    expect(sql().split("begin;")[0]).not.toMatch(/https?:|\/(app|api)\/|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
