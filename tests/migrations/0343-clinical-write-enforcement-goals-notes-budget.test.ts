import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0343 (W1 remainder) source contract. The behaviour is proved against a database in tests/db/clinical-write-enforcement-0343.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0343")}`, "utf8");
const down = () => readFileSync(`supabase/rollbacks/${fileForVersion("0343").replace(/\.sql$/, ".down.sql")}`, "utf8");
const code = (t: string) => t.replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const keyed = (key: string) => `studio_id in (select k from public.clin_key_studios('${key}') k)`;
const ATTRIB =
  "exists ( select 1 from public.practitioners p where p.id = client_budget_context.updated_by_practitioner_id and p.studio_id = client_budget_context.studio_id and p.user_id = (select auth.uid()) and p.active )";

// policy -> [table, command, using, with check]
const EXPECTED: Record<string, [string, "insert" | "update", string | null, string]> = {
  treatment_goals_studio_member_insert: ["treatment_goals", "insert", null, keyed("clin.view_records")],
  treatment_goals_studio_member_update: ["treatment_goals", "update", keyed("clin.view_records"), keyed("clin.view_records")],
  client_pinned_notes_studio_member_insert: ["client_pinned_notes", "insert", null, keyed("clin.view_records")],
  client_personal_notes_studio_member_insert: ["client_personal_notes", "insert", null, keyed("client.view_personal_notes")],
  client_personal_notes_studio_member_update: ["client_personal_notes", "update", keyed("client.view_personal_notes"), keyed("client.view_personal_notes")],
  client_budget_context_member_insert: ["client_budget_context", "insert", null, `${keyed("client.view_budget")} and ${ATTRIB}`],
  client_budget_context_member_update: ["client_budget_context", "update", keyed("client.view_budget"), `${keyed("client.view_budget")} and ${ATTRIB}`],
};

function parse(text: string) {
  const out: Record<string, [string, string | null, string]> = {};
  for (const s of code(text).split(";").filter((x) => /alter policy/.test(x))) {
    const m = /alter policy (\w+) on public\.(\w+) to (\w+)\s+(?:using\s*\(([\s\S]*?)\)\s+)?with check\s*\(([\s\S]*)\)\s*$/.exec(s.trim());
    expect(m, s).not.toBeNull();
    out[m![1]] = [m![2], m![4] ? norm(m![4]) : null, norm(m![5])];
  }
  return out;
}

describe("0343 clinical write enforcement, goals / pinned / personal / budget (source)", () => {
  it("exists exactly once", () => {
    expect(countVersion("0343")).toBe(1);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code(sql());
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });
  it("changes exactly the seven INSERT/UPDATE policies, each `to authenticated`, with EXACTLY the expected USING and WITH CHECK", () => {
    const seen = parse(sql());
    const want: Record<string, [string, string | null, string]> = {};
    for (const [name, [table, , using, check]] of Object.entries(EXPECTED)) want[name] = [table, using, check];
    expect(seen).toEqual(want);
    for (const s of code(sql()).split(";").filter((x) => /alter policy/.test(x))) expect(s).toMatch(/ to authenticated\s/);
  });
  it("every UPDATE policy has the same key in USING and WITH CHECK (an upsert and a row move are judged by one key)", () => {
    for (const [name, [, cmd, using, check]] of Object.entries(EXPECTED)) {
      if (cmd === "update") expect(check.startsWith(using!), name).toBe(true);
    }
  });
  it("each write key is the SAME key as the table's 0335 read key", () => {
    const read = readFileSync(`supabase/migrations/${fileForVersion("0335")}`, "utf8");
    for (const [name, [table, , , check]] of Object.entries(EXPECTED)) {
      const key = /clin_key_studios\('([^']+)'\)/.exec(check)![1];
      const r = new RegExp(`alter policy \\w+ on public\\.${table} to authenticated\\s+using \\(studio_id in \\(select k from public\\.clin_key_studios\\('${key.replace(/\./g, "\\.")}'\\)`).test(read);
      expect(r, `${name}: ${key} is not the 0335 read key of ${table}`).toBe(true);
    }
  });
  it("targets live policy names that exist in earlier migrations (alter policy cannot fail on a rename)", () => {
    const all = readdirSync("supabase/migrations").filter((n: string) => n < fileForVersion("0343") && n.endsWith(".sql"));
    const text = all.map((n: string) => readFileSync(`supabase/migrations/${n}`, "utf8")).join("\n");
    for (const [name, [table]] of Object.entries(EXPECTED)) {
      expect(text, name).toMatch(new RegExp(`create policy "?${name}"?\\s+on public\\.${table}`));
    }
  });
  it("uses only the 0333 helper, no membership-only branch, no new function, grant, revoke or trigger", () => {
    const c = code(sql());
    expect(c).not.toMatch(/create (or replace )?function|create trigger|\b(grant|revoke)\b|drop policy|create policy/i);
    expect(c).not.toMatch(/is_studio_member|session_is_visible|has_studio_permission\(/);
  });
  it("adds NO UPDATE policy to client_pinned_notes and leaves its DELETE policy alone (the edit action is a documented system path)", () => {
    const c = code(sql());
    expect(c).not.toMatch(/client_pinned_notes_studio_member_(update|delete|read)|client_pinned_notes_owner_delete/);
    expect(sql()).toMatch(/SYSTEM PATH/);
  });
  it("keeps the budget attribution clause on both budget policies", () => {
    for (const name of ["client_budget_context_member_insert", "client_budget_context_member_update"]) {
      expect(parse(sql())[name][2]).toContain(ATTRIB);
    }
  });
  it("marks the proposed defaults for Sam", () => {
    expect(sql()).toMatch(/PROPOSED DEFAULTS, SAM TO CONFIRM/);
  });
  it("has a rollback that restores the seven membership-only policies", () => {
    const d = code(down());
    for (const name of Object.keys(EXPECTED)) expect(d, name).toContain(`alter policy ${name} on`);
    expect(d).not.toMatch(/clin_key_studios/);
    expect(d).toMatch(/is_studio_member\(studio_id\)/);
    expect(d).toMatch(/alter policy client_pinned_notes_studio_member_insert on public\.client_pinned_notes to public/);
  });
});
