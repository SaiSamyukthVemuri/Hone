import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion, isRepoMax } from "./helpers/migration-state";

// 0335 (I3) source contract. The behaviour is proved against a database in tests/db/clin-read-enforcement-plans-notes.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0335")}`, "utf8");
const code = () => sql().replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();
const keyed = (key: string) => `studio_id in (select k from public.clin_key_studios('${key}') k)`;

// table -> [exact policy name, exact USING qual]
const EXPECTED: Record<string, [string, string]> = {
  treatment_plans: ["treatment_plans_studio_member_read", keyed("clin.view_records")],
  treatment_plan_stages: ["treatment_plan_stages_studio_member_select", keyed("clin.view_records")],
  treatment_goals: ["treatment_goals_studio_member_select", keyed("clin.view_records")],
  client_clinical_notes: ["client_clinical_notes_member_select", keyed("clin.view_records")],
  client_pinned_notes: ["client_pinned_notes_studio_member_read", keyed("clin.view_records")],
  clinical_record_snapshots: ["clinical_record_snapshots_member_select", keyed("clin.view_records")],
  clinical_record_amendments: ["clinical_record_amendments_member_select", keyed("clin.view_records")],
  client_personal_notes: ["client_personal_notes_studio_member_select", keyed("client.view_personal_notes")],
  client_budget_context: ["client_budget_context_member_select", keyed("client.view_budget")],
  clinical_audit_events: ["clinical_audit_events_member_select", `${keyed("clin.view_records")} and ${keyed("rep.audit_log_view")}`],
};

describe("0335 clinical-read enforcement, plans and notes (source)", () => {
  it("exists exactly once and is the current repo maximum", () => {
    expect(countVersion("0335")).toBe(1);
    expect(isRepoMax("0335")).toBe(true);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code();
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });
  it("changes exactly the ten SELECT policies, each `to authenticated`, and each USING clause is EXACTLY the expected qual (no extra branch, no WITH CHECK)", () => {
    const stmts = code().split(";").filter((s) => /alter policy/.test(s));
    const seen: Record<string, [string, string]> = {};
    for (const s of stmts) {
      const m = /alter policy (\w+) on public\.(\w+) to authenticated\s+using\s*\(([\s\S]*)\)\s*$/.exec(s.trim());
      expect(m, s).not.toBeNull();
      seen[m![2]] = [m![1], norm(m![3])];
      expect(s).not.toMatch(/\bwith check\b/i);
    }
    expect(seen).toEqual(EXPECTED);
  });
  it("targets the live policy names (each exists in an earlier migration, so `alter policy` cannot fail on a rename)", () => {
    const all = readdirSync("supabase/migrations").filter((n: string) => n < fileForVersion("0335") && n.endsWith(".sql"));
    const text = all.map((n: string) => readFileSync(`supabase/migrations/${n}`, "utf8")).join("\n");
    for (const [table, [name]] of Object.entries(EXPECTED)) {
      expect(text, `${table}: ${name}`).toMatch(new RegExp(`create policy "?${name}"?\\s+on public\\.${table}`));
    }
  });
  it("uses only the 0333 helper (no new function), no membership-only branch, and the two-key table asks BOTH keys", () => {
    const c = code();
    expect(c).not.toMatch(/create (or replace )?function/i);
    expect(c).not.toMatch(/is_studio_member|session_is_visible/);
    const audit = norm(/alter policy clinical_audit_events_member_select[\s\S]*?;/.exec(c)![0]);
    expect(audit).toContain("clin_key_studios('clin.view_records')");
    expect(audit).toContain("clin_key_studios('rep.audit_log_view')");
  });
  it("changes no insert/update/delete policy, no table grant and no write path", () => {
    const c = code();
    expect(c).not.toMatch(/\bfor (insert|update|delete)\b/i);
    expect(c).not.toMatch(/\b(grant|revoke)\b/i);
    expect(c).not.toMatch(/drop policy|disable row level security|force row level security/i);
  });
  it("marks the proposed defaults for Sam", () => {
    expect(sql()).toMatch(/PROPOSED DEFAULTS, SAM TO CONFIRM/);
  });
});
