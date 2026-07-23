import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Source/structural contract for migration 0137 (scoped timed blocks + breaks).

const DIR = join(process.cwd(), "supabase/migrations");
const FILE = readdirSync(DIR).find((f) => f.startsWith("0137_"));
const SQL = FILE ? readFileSync(join(DIR, FILE), "utf8") : "";
const CODE = SQL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*--.*$/gm, "");

describe("0137 — file + scoped columns", () => {
  it("exists and adds practitioner_id to the three sources", () => {
    expect(FILE).toBe("0137_scoped_blocks_and_breaks.sql");
    for (const t of ["studio_timed_blocks", "studio_recurring_break_rules", "studio_recurring_break_occurrences"]) {
      expect(CODE).toMatch(new RegExp(`alter table public\\.${t}\\s+add column if not exists practitioner_id uuid`, "i"));
    }
  });
  it("uses ON DELETE RESTRICT for the practitioner relationship (never SET NULL)", () => {
    const fkCount = (CODE.match(/foreign key \(practitioner_id, studio_id\)\s*references public\.practitioners \(id, studio_id\) on delete restrict/gi) ?? []).length;
    expect(fkCount).toBe(3);
    // No SET NULL that would silently widen a scoped source to studio-wide.
    expect(CODE).not.toMatch(/practitioner_id[\s\S]{0,80}on delete set null/i);
  });
});

describe("0137 — canonical scope-aware synchronizer", () => {
  it("defines sync_scoped_calendar_reservation with the four-way state behaviour", () => {
    const fn = CODE.match(/function public\.sync_scoped_calendar_reservation[\s\S]*?\$\$;/i)?.[0];
    expect(fn).toBeTruthy();
    // Scoped + ON => one practitioner-keyed row; scoped + OFF => zero rows (dormant).
    expect(fn).toMatch(/if p_practitioner_id is not null then[\s\S]*?if public\.studio_capacity_enabled/i);
    expect(fn).toMatch(/resource_key.*p_practitioner_id|p_practitioner_id, p_practitioner_id/i);
    // Studio-wide keeps fan-out (ON) / one studio row (OFF).
    expect(fn).toMatch(/from public\.practitioners pr\s*where pr\.studio_id = p_studio_id/i);
    // Does NOT swallow the GiST conflict.
    expect(fn).not.toMatch(/exception\s+when/i);
  });
  it("fanout, timed-block, recurring mirrors, and rematerialize all route through it", () => {
    expect((CODE.match(/sync_scoped_calendar_reservation\(/g) ?? []).length).toBeGreaterThanOrEqual(6);
  });
});

describe("0137 — scope guard takes the lock first + capacity/active", () => {
  it("guard_scoped_source_capacity acquires the studio lock before validating", () => {
    const fn = CODE.match(/function public\.guard_scoped_source_capacity[\s\S]*?\$\$;/i)?.[0];
    expect(fn).toMatch(/acquire_studio_capacity_lock\(new\.studio_id\)[\s\S]*if new\.practitioner_id is not null/i);
    expect(fn).toMatch(/studio_capacity_enabled\(new\.studio_id\)/i);
    expect(fn).toMatch(/p\.active = true/i);
  });
  it("owner-only scoped timed-block writes (member INSERT limited to studio-wide)", () => {
    expect(CODE).toMatch(/create policy "studio_timed_blocks_member_insert"[\s\S]*?with check \(public\.is_studio_member\(studio_id\) and practitioner_id is null\)/i);
  });
});

describe("0137 — recurring RPCs are scope-aware + operator-only", () => {
  it("occurrences copy the rule practitioner_id; create/update gain an optional scope param", () => {
    expect(CODE).toMatch(/insert into public\.studio_recurring_break_occurrences\s*\(rule_id, studio_id, practitioner_id/i);
    expect(CODE).toMatch(/create or replace function public\.create_recurring_break_rule_and_materialize\([\s\S]*?p_practitioner_id\s+uuid default null/i);
    expect(CODE).toMatch(/create or replace function public\.update_recurring_break_rule_and_rematerialize\([\s\S]*?p_practitioner_id\s+uuid default null/i);
  });
  it("new helpers are execute-revoked from browser roles", () => {
    for (const sig of [
      "public.guard_scoped_source_capacity()",
      "public.sync_scoped_calendar_reservation(uuid, uuid, text, uuid, timestamptz, timestamptz)",
    ]) {
      expect(CODE).toContain(sig);
    }
    expect(CODE).toMatch(/revoke execute on function %s from authenticated/i);
  });
});
