import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0348 source contract. The behaviour is proved against a database in tests/db/client-tags-edit-key-gate-0348.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0348")}`, "utf8");
const down = () => readFileSync(`supabase/rollbacks/${fileForVersion("0348").replace(/\.sql$/, ".down.sql")}`, "utf8");
const code = (t: string) => t.replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const GATE = "public.is_studio_member(studio_id) and public.has_studio_permission(studio_id, 'client.edit_tags', client_id)";

describe("0348 client tags: writes require the tag-edit permission (source)", () => {
  it("exists exactly once and is the current repo maximum", () => {
    expect(countVersion("0348")).toBe(1);
    expect(isRepoMax("0348")).toBe(true);
  });

  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code(sql());
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });

  it("alters exactly the member INSERT and UPDATE policies, keeping the member check and adding the key", () => {
    const c = norm(code(sql()));
    expect(c).toContain(`alter policy client_tags_member_insert on public.client_tags to authenticated with check ( ${GATE} );`);
    expect(c).toContain(`alter policy client_tags_member_update on public.client_tags to authenticated using ( ${GATE} ) with check ( ${GATE} );`);
    expect((c.match(/alter policy/g) ?? []).length).toBe(2);
  });

  it("changes nothing else: no table, grant, revoke, trigger, function or data statement", () => {
    const c = code(sql());
    expect(c).not.toMatch(/(^|;)\s*(create|drop|grant|revoke|insert|update|delete|truncate)\s/gim);
    expect(c).not.toMatch(/alter\s+table|create\s+(or\s+replace\s+)?function|create\s+trigger/i);
  });

  it("refuses to apply when the key row is missing or authenticated cannot execute the engine", () => {
    const c = norm(code(sql()));
    expect(c).toContain("from public.permission_catalog where key = 'client.edit_tags'");
    expect(c).not.toContain("studio_permission_policy");
    expect(c).toContain("has_function_privilege('authenticated', 'public.has_studio_permission(uuid,text,uuid,uuid,uuid)', 'EXECUTE')");
  });

  it("ends with a guard that every write policy now names the key and that no DELETE or ALL policy exists", () => {
    const c = norm(code(sql()));
    expect(c).toContain("from pg_catalog.pg_policy p where p.polrelid = 'public.client_tags'::regclass");
    expect(c).toContain("does not require client.edit_tags");
    expect(c).toContain("unexpected DELETE or ALL policy");
    expect(c).toContain("expected exactly one INSERT and one UPDATE policy");
  });

  it("leaves SELECT alone", () => {
    expect(code(sql())).not.toMatch(/client_tags_member_select/);
  });

  it("is marked not applied and carries an operator down file that restores the 0087 policies", () => {
    expect(sql()).toMatch(/NOT APPLIED/);
    const d = norm(code(down()));
    expect(d).toContain("alter policy client_tags_member_insert on public.client_tags to authenticated with check (public.is_studio_member(studio_id));");
    expect(d).toContain("alter policy client_tags_member_update on public.client_tags to authenticated using (public.is_studio_member(studio_id)) with check (public.is_studio_member(studio_id));");
    expect(d).not.toMatch(/has_studio_permission/);
    expect(down()).toMatch(/begin;/);
    expect(down()).toMatch(/commit;/);
  });

  it("states the rule without naming a route or internal identifier", () => {
    const head = sql().split("begin;")[0];
    expect(head).not.toMatch(/https?:|\/(app|api)\/|[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});
