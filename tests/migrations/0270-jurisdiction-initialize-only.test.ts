import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isRepoMax } from "./helpers/migration-state";

// 0270: the initialize-only owner confirmation command. Source contract; the
// behaviour (race, grants, parity) is proved by the DB test.

const MIGRATIONS = path.resolve(__dirname, "../../supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const NEW = read("0270_studio_payment_jurisdiction_initialize_only.sql");
const OLD = read("0214_studio_payment_jurisdiction.sql");
const code = (s: string) => s.replace(/--[^\n]*/g, "");
const FN = "initialize_studio_payment_jurisdiction_owner(uuid, text, text, text, text, text)";

describe("0270 source contract", () => {
  it("is the current maximum and opens its own transaction with a lock timeout", () => {
    expect(isRepoMax("0270")).toBe(true);
    expect(code(NEW)).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
    expect(code(NEW).trim().endsWith("commit;")).toBe(true);
  });

  it("is security definer with a pinned search_path", () => {
    expect(code(NEW)).toMatch(/security definer\s+set search_path = pg_catalog, pg_temp/);
  });

  it("revokes by name from all four roles, then grants service_role only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(code(NEW)).toContain(`revoke execute on function public.${FN} from ${role};`);
    }
    expect(code(NEW)).toContain(`grant execute on function public.${FN} to service_role;`);
    expect(code(NEW).match(/grant execute/g)).toHaveLength(1);
  });

  it("never updates the jurisdiction row", () => {
    expect(code(NEW)).not.toMatch(/update\s+public\.studio_payment_jurisdictions/i);
    expect(code(NEW)).not.toMatch(/'changed'/);
  });

  it("uses 0214's lock order and its refusal predicates verbatim", () => {
    const lock = /for no key update;[\s\S]*?for update;[\s\S]*?from public\.studios st where st\.id = p_studio_id for update;/;
    expect(code(NEW)).toMatch(lock);
    expect(code(OLD)).toMatch(lock);
    const predicates = (s: string) =>
      [...code(s).matchAll(/exists \(select 1 from public\.(\w+)\s+\w+\s+where [^)]*\)/g)].map((m) => m[1]);
    for (const table of [
      "stripe_account_provisioning_attempts",
      "client_payment_methods",
      "client_stripe_customers",
      "payment_charge_attempts",
      "appointment_settlements",
      "manual_fee_charge_attempts",
      "appointment_payments",
      "stripe_charge_attempts",
      "pending_booking_payment_sessions",
      "services",
      "client_pricing",
    ]) {
      expect(predicates(NEW), table).toContain(table);
      expect(predicates(OLD), table).toContain(table);
    }
  });

  it("does not touch 0214", () => {
    expect(OLD).toContain("set_studio_payment_jurisdiction");
    expect(OLD).not.toContain("initialize_studio_payment_jurisdiction_owner");
  });
});
