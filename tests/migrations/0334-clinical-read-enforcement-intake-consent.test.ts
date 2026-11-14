import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// 0334 (I2) source contract. The behaviour is proved against a database in tests/db/clin-read-enforcement-intake-consent.db.test.ts.
const sql = () => readFileSync(`supabase/migrations/${fileForVersion("0334")}`, "utf8");
const code = () => sql().replace(/--[^\n]*/g, "");
const norm = (t: string) => t.replace(/\s+/g, " ").trim();

describe("0334 clinical-read enforcement, intake and consent (source)", () => {
  it("exists exactly once", () => {
    expect(countVersion("0334")).toBe(1);
  });
  it("opens its own transaction and arms lock_timeout inside it", () => {
    const c = code();
    expect(c.indexOf("begin;")).toBeGreaterThanOrEqual(0);
    expect(c.indexOf("set local lock_timeout")).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.trim().endsWith("commit;")).toBe(true);
  });
  it("each of the three SELECT policies is `to authenticated` and its USING clause is EXACTLY clin.view_intake through clin_key_studios (no extra branch)", () => {
    const stmts = code().split(";").filter((s) => /alter policy/.test(s));
    const seen: Record<string, string> = {};
    for (const s of stmts) {
      const table = /on public\.(\w+)/.exec(s)![1];
      expect(s, table).toMatch(/\bto authenticated\b/);
      const using = /\busing\s*\(([\s\S]*)\)\s*$/.exec(s.trim());
      expect(using, table).not.toBeNull();
      seen[table] = norm(using![1]);
      expect(s, table).not.toMatch(/\bwith check\b/i);
    }
    const EXPECTED = "studio_id in (select k from public.clin_key_studios('clin.view_intake') k)";
    expect(seen).toEqual({ client_intake_forms: EXPECTED, client_consent_signatures: EXPECTED, appointment_policy_acknowledgements: EXPECTED });
  });
  it("targets the live policy names (a rename upstream would make `alter policy` fail, not silently skip)", () => {
    const c = code();
    expect(c).toContain("alter policy client_intake_forms_member_select on public.client_intake_forms");
    expect(c).toContain("alter policy client_consent_signatures_studio_member_select on public.client_consent_signatures");
    expect(c).toContain("alter policy appointment_policy_acks_studio_member_select on public.appointment_policy_acknowledgements");
  });
  it("the projection is SECURITY DEFINER, stable, search_path empty; revoked from public/anon/authenticated/service_role by name; granted to authenticated only", () => {
    const c = code();
    expect(c).toMatch(/create or replace function public\.intake_status_for_clients\(p_studio_id uuid, p_client_ids uuid\[\] default null\)[\s\S]*?stable[\s\S]*?security definer[\s\S]*?set search_path = ''/);
    expect(c).toMatch(/revoke all on function public\.intake_status_for_clients\(uuid, uuid\[\]\) from public, anon, authenticated, service_role;/);
    expect(c).toMatch(/grant execute on function public\.intake_status_for_clients\(uuid, uuid\[\]\) to authenticated;/);
    expect(c).not.toMatch(/grant execute on function public\.intake_status_for_clients\([^)]*\) to (anon|service_role|public)/);
  });
  it("the projection returns status only: never `responses`, and gates on BOTH keys through clin_key_studios, newest non-deleted row per client", () => {
    const fn = /create or replace function public\.intake_status_for_clients[\s\S]*?\$\$;/.exec(code())![0];
    expect(fn).toMatch(/returns table \(client_id uuid, status text, created_at timestamptz\)/);
    expect(fn).not.toMatch(/responses|practitioner_notes|acknowledg|consent/i);
    expect(fn).toMatch(/clin_key_studios\('clin\.view_intake_status'\)/);
    expect(fn).toMatch(/clin_key_studios\('clin\.view_intake'\)/);
    expect(fn).toMatch(/f\.deleted_at is null/);
    expect(fn).toMatch(/distinct on \(f\.client_id\)[\s\S]*order by f\.client_id, f\.created_at desc, f\.id desc/);
  });
  it("changes no insert/update/delete policy, no table grant and no write path", () => {
    const c = code();
    expect(c).not.toMatch(/\bfor (insert|update|delete)\b/i);
    expect(c).not.toMatch(/\b(grant|revoke)\b[^;]*\bon (table )?public\.(client_|appointment_)/i);
    expect(c).not.toMatch(/drop policy|disable row level security|force row level security/i);
  });
  it("the projection's result columns are EXACTLY (client_id, status, created_at): no answers and no consent contents can ride through it (Sam, 12 Nov)", () => {
    const fn = /create or replace function public\.intake_status_for_clients[\s\S]*?\$\$;/.exec(code())![0];
    expect(norm(/returns table \(([^)]*)\)/.exec(fn)![1])).toBe("client_id uuid, status text, created_at timestamptz");
    // and the select list feeding those columns is exactly the same three columns of the form row
    expect(norm(/select distinct on \(f\.client_id\) ([\s\S]*?) from /.exec(fn)![1])).toBe("f.client_id, f.status, f.created_at");
    expect(fn).not.toMatch(/client_consent_signatures|appointment_policy_acknowledgements/);
  });
  it("records Sam's decision instead of a pending confirmation", () => {
    expect(sql()).not.toMatch(/SAM TO CONFIRM|PROPOSED DEFAULTS/);
    expect(sql()).toMatch(/Decided \(Sam, 12 Nov 2026, ROLES-DECISIONS-LOG/);
  });
});
