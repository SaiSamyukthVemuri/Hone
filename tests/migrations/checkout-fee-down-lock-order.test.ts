import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The checkout fee down file refuses once any adjusted settlement exists, because that evidence must be kept.
// The refusal is only sound if it is made while holding the table lock: a row written between an unlocked
// check and the column drop would be destroyed with the column. So, inside the one transaction and after the
// lock timeout, the table is locked BEFORE the existence check, and the check comes before every drop.
describe("0381 down file: lock, then check, then drop", () => {
  const sql = readFileSync("supabase/rollbacks/0381_adjusted_external_checkout_fee.down.sql", "utf8");
  const at = (needle: string | RegExp) => {
    const m = typeof needle === "string" ? sql.indexOf(needle) : sql.search(needle);
    expect(m, String(needle)).toBeGreaterThanOrEqual(0);
    return m;
  };

  it("runs in one transaction whose lock timeout is set before the lock", () => {
    expect(at(/^begin;/m)).toBeLessThan(at("set local lock_timeout"));
    expect(at("set local lock_timeout")).toBeLessThan(at("lock table public.appointment_settlements in access exclusive mode;"));
    expect(at("commit;")).toBeGreaterThan(at("drop column fee_adjustment_reason"));
  });

  it("takes the exclusive table lock before it checks for adjusted rows", () => {
    expect(at("lock table public.appointment_settlements in access exclusive mode;")).toBeLessThan(at("reference_fee_cents is not null"));
  });

  it("checks for adjusted rows before dropping anything", () => {
    const check = at("Adjusted settlements exist");
    for (const drop of ["drop function public.record_adjusted_appointment_settlement", "drop trigger", "drop function public.preserve_settlement_fee_adjustment", "drop constraint", "drop column reference_fee_cents"]) {
      expect(check, drop).toBeLessThan(at(drop));
    }
  });
});
