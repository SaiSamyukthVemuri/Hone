import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// 0280 receptionist name rule: source contract. The behaviour is proved on a real database in
// tests/db/receptionist-name-rule.db.test.ts; this pins the shape so a refactor cannot quietly bring the
// stored name back into a receptionist function.

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0280_receptionist_name_rule.sql"), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n");
const fn = (name: string) => {
  const m = code.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;|create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$function\\$;`));
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
};

describe("0280 receptionist name rule", () => {
  it("opens its own transaction with a lock timeout and touches no table, policy or trigger", () => {
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/set local lock_timeout = '5s';/);
    expect(code).toMatch(/commit;\s*$/);
    expect(code).not.toMatch(/\b(create|alter|drop)\s+(table|policy|trigger|index)\b/i);
  });
  it("the directory and the schedule show the preferred name or the literal label, and never select the stored name", () => {
    for (const name of ["receptionist_client_directory", "receptionist_calendar_v2"]) {
      const body = fn(name);
      expect(body).toContain("'Name on file'");
      expect(body).not.toMatch(/\bc\.name\b/);
    }
  });
  it("search is over the preferred name, email and phone; the shown label is not a search key", () => {
    const body = fn("receptionist_client_directory");
    expect(body).toMatch(/b\.pname\s+ilike v_pattern/);
    expect(body).toMatch(/b\.cemail ilike v_pattern/);
    expect(body).toMatch(/b\.cphone ilike v_pattern/);
    expect(body).not.toMatch(/b\.dname\s+ilike/);
  });
  it("the returned columns stay exactly the 0274 set (no pname leaks into the select list)", () => {
    const body = fn("receptionist_client_directory");
    expect(body).not.toMatch(/fl\.pname/);
    expect(body).toMatch(/select fl\.id, fl\.dname, fl\.on_file, fl\.cphone, fl\.cemail, fl\.nxt, fl\.lastv_on,/);
  });
  it("closes the v2 contacts finder to all four roles, by name", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code).toContain(`revoke execute on function public.receptionist_client_contacts_v2(uuid, text, integer) from ${role};`);
    }
  });
  it("caps the cancellation reason at 500 with a distinct error, after the receptionist check", () => {
    const body = fn("receptionist_cancel_appointment");
    expect(body).toMatch(/char_length\(p_reason\) > 500/);
    expect(body).toContain("using errcode = '22023'");
    expect(body.indexOf("not_authorized")).toBeLessThan(body.indexOf("reason_too_long"));
  });
  it("refuses to apply without 0220 and 0274", () => {
    expect(code).toContain("0280 requires 0220 and 0274; not applying");
  });
});
