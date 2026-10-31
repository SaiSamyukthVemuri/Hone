import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { countVersion, fileForVersion } from "./helpers/migration-state";

// SOURCE CONTRACT, NOT DB PROOF. The behaviour is proved by
// tests/db/practitioner-calendar-preferences.db.test.ts in the CI DB lane.
const sql = readFileSync(
  "supabase/migrations/0273_practitioner_calendar_preferences.sql",
  "utf8",
);
const executable = sql.replace(/--[^\n]*/g, "");
const CMD = "public.set_own_calendar_preferences(uuid, jsonb)";

describe("0273 practitioner calendar preferences source contract", () => {
  it("owns its reserved file, atomic and additive", () => {
    expect(countVersion("0273")).toBe(1);
    expect(fileForVersion("0273")).toBe("0273_practitioner_calendar_preferences.sql");
    expect(sql).toMatch(/begin;\s*set local lock_timeout = '5s';/);
    expect(sql.trim()).toMatch(/commit;$/);
    expect(executable).not.toMatch(/drop (table|function|column)|alter table public\.(studios|practitioners)\b/i);
    expect(executable).not.toMatch(/update public\.studios|insert into public\.studios/i);
  });

  it("closes every writer by name and grants only SELECT on the table and EXECUTE on the command", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(sql).toContain(`revoke all on public.practitioner_calendar_preferences from ${role};`);
      expect(sql).toContain(`revoke execute on function ${CMD} from ${role};`);
    }
    expect(sql).toContain("grant select on public.practitioner_calendar_preferences to authenticated;");
    expect(sql).toContain(`grant execute on function ${CMD} to authenticated;`);
    expect(executable.match(/\bgrant\b/gi)?.length).toBe(2);
    expect(executable).not.toMatch(/grant [^;]*\bservice_role/i);
    expect(executable).not.toMatch(/grant (insert|update|delete|all)/i);
  });

  it("creates exactly one function, and its EXECUTE is revoked from all four default roles", () => {
    const created = [...executable.matchAll(/create (?:or replace )?function\s+(public\.[a-z_]+)/gi)];
    expect(created.map((m) => m[1])).toEqual(["public.set_own_calendar_preferences"]);
  });

  it("is own-row only: one SELECT policy bound to auth.uid(), no write policy, composite same-studio FK", () => {
    const policies = [...executable.matchAll(/create policy/gi)];
    expect(policies).toHaveLength(1);
    expect(executable).toMatch(/for select to authenticated/);
    expect(executable).toContain("p.user_id = (select auth.uid())");
    expect(executable).not.toMatch(/create policy[^;]*for (insert|update|delete|all)/i);
    expect(executable).not.toMatch(/is_studio_member/);
    expect(executable).toContain("foreign key (practitioner_id, studio_id)");
    expect(executable).toContain("references public.practitioners (id, studio_id)");
    expect(executable).toContain("enable row level security");
  });

  it("is a definer command with a pinned search_path whose actor is auth.uid(), never a parameter", () => {
    const body = sql.slice(sql.indexOf("create or replace function public.set_own_calendar_preferences"));
    expect(body).toContain("security definer");
    expect(body).toContain("set search_path = pg_catalog, pg_temp");
    expect(body).toContain("public.own_practitioner_in_studio(p_studio_id)");
    expect(body).not.toMatch(/p_practitioner|p_user/);
    // Validation precedes every write.
    expect(body.indexOf("Unsupported value")).toBeLessThan(body.indexOf("insert into"));
    expect(body.indexOf("Unknown calendar preference")).toBeLessThan(body.indexOf("insert into"));
    expect(body).toMatch(/for update;/);
  });

  it("stores only the four closed-set overrides, nullable", () => {
    for (const c of [
      "time_format_override", "default_calendar_view", "birthday_display", "birthday_color",
    ]) expect(sql).toMatch(new RegExp(`${c} text\\s+check \\(${c} is null`));
    expect(sql).toContain("('12h', '24h')");
    expect(sql).toContain("('day', 'week', 'month')");
    expect(sql).toContain("('show', 'hide')");
    expect(sql).toContain("('purple', 'orange', 'blue', 'green', 'neutral')");
  });
});
