import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 0351: rollback file contract. Behaviour is proved against a real database in tests/db/studio-manual-fee-settings.db.test.ts.

const root = join(__dirname, "..", "..");
const NAME = "0351_studio_manual_fee_settings";
const exec = (sql: string) => sql.split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
const DOWN = exec(readFileSync(join(root, `supabase/rollbacks/${NAME}.down.sql`), "utf8"));

describe("0351: rollback", () => {
  it("rollback removes every object the migration added", () => {
    for (const re of [
      /drop trigger if exists studios_manual_fee_setting_audit on public\.studios/,
      /drop function if exists public\.studios_manual_fee_setting_audit\(\)/,
      /drop table if exists public\.studio_manual_fee_setting_changes/,
      /drop trigger if exists payment_charge_attempts_calc_basis_immutable/,
      /drop function if exists public\.payment_charge_attempts_calc_basis_immutable\(\)/,
      /drop constraint if exists payment_charge_attempts_calc_basis_check/,
      /drop column if exists calc_mode/, /drop column if exists basis_cents/, /drop column if exists percent_bp/,
      /drop column if exists late_cancel_fee_enabled/, /drop column if exists no_show_fee_enabled/,
      /drop column if exists late_cancel_fee_mode/, /drop column if exists no_show_fee_mode/,
      /drop column if exists late_cancel_fee_percent_bp/, /drop column if exists no_show_fee_percent_bp/,
    ]) expect(DOWN).toMatch(re);
    expect(DOWN).toMatch(/^\s*begin;\s*set local lock_timeout = '5s';/);
  });
});
