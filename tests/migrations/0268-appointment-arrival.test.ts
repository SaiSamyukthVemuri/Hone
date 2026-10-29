import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// HON-48 / 0268 source contract. Behaviour is proved against a real database in
// tests/db/appointment-arrival.db.test.ts.

const SQL = readFileSync("supabase/migrations/0268_appointment_arrival.sql", "utf8");
const lower = SQL.toLowerCase();

describe("0268 appointment arrival: source contract", () => {
  it("is the repository maximum (the tripwire for the next migration)", () => {
    expect(isRepoMax("0268")).toBe(true);
  });
  it("opens its own transaction with a lock timeout inside it", () => {
    expect(lower).toMatch(/\nbegin;\nset local lock_timeout = '5s';/);
    expect(lower.trimEnd().endsWith("commit;")).toBe(true);
  });
  it("adds exactly one nullable column and no status value, no backfill, no data change", () => {
    expect(lower).toMatch(/alter table public\.appointments add column arrived_at timestamptz;/);
    expect(lower).not.toMatch(/appointments_status_check|appointment_transition_allowed/);
    expect(lower).not.toMatch(/\bupdate public\.appointments set arrived_at = now\(\) where (?!id = v_appt)/);
    expect(lower).not.toMatch(/\bdelete from\b|\binsert into public\.(?!appointment_audit)/);
  });
  it("the receptionist decision is ONE constant-false predicate, and only the command and actor read it", () => {
    expect(lower).toMatch(/create function public\.arrival_receptionist_allowed\(\)[\s\S]*?as \$\$ select false \$\$;/);
    const body = (name: string) => {
      const start = lower.indexOf(`create function public.${name}`);
      return lower.slice(start, lower.indexOf("$$;", lower.indexOf("as $$", start)) + 3);
    };
    expect(body("appointment_arrival_actor")).toContain("if public.arrival_receptionist_allowed() then");
    // the command asks only the actor function; it never reads the predicate itself
    expect(body("set_appointment_arrived")).not.toContain("arrival_receptionist_allowed");
    expect(body("clear_arrival_on_close")).not.toContain("arrival_receptionist_allowed");
  });
  it("the actor is derived from auth.uid(), never a parameter", () => {
    expect(lower).toMatch(/pr\.user_id = auth\.uid\(\)/);
    expect(lower).not.toMatch(/p_actor|p_practitioner_id|p_receptionist/);
  });
  it("every function revokes all four API roles by name; only the command is granted, to authenticated alone", () => {
    for (const fn of [
      "public.arrival_receptionist_allowed()",
      "public.appointment_arrival_actor(uuid)",
      "public.set_appointment_arrived(uuid, uuid, boolean)",
      "public.clear_arrival_on_close()",
    ]) {
      expect(lower).toContain(`revoke all on function ${fn} from public, anon, authenticated, service_role;`);
    }
    expect(lower).toContain("grant execute on function public.set_appointment_arrived(uuid, uuid, boolean) to authenticated;");
    expect((lower.match(/\bgrant\b/g) ?? []).length).toBe(1);
  });
  it("definer functions pin search_path", () => {
    for (const m of lower.matchAll(/security definer\n(set search_path[^\n]*)/g)) expect(m[1]).toContain("pg_catalog, pg_temp");
    expect((lower.match(/security definer/g) ?? []).length).toBe(2);
  });
});
