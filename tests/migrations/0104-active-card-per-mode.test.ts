import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

// Migration 0104: rescope client_payment_methods_one_active_per_pair to
// (studio_id, client_id, stripe_livemode) WHERE status='active', so a client
// can hold one active TEST card and one active LIVE card simultaneously,
// required by the mode-scoped webhook pre-flip (saving a live card no longer
// retires the test card row, so the live INSERT must not collide with the old
// per-pair unique). Behavioral proof: tests/db/active-card-per-mode.db.test.ts.

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");
const FILE = "0104_one_active_card_per_pair_per_mode.sql";
const SOURCE = readFileSync(path.join(MIGRATIONS_DIR, FILE), "utf8");
const CODE = SOURCE.replace(/--.*$/gm, "");

describe("0104: migration number + scope", () => {
  it("is numbered 0104 (immediately after 0103)", () => {
    const nums = readdirSync(MIGRATIONS_DIR)
      .map((f) => /^(\d{4})_/.exec(f)?.[1])
      .filter(Boolean)
      .map((n) => Number(n));
    // 0104 exists and 0103 precedes it; the global-max tripwire lives in the
    // newest migration's test.
    expect(nums).toContain(104);
    expect(nums).toContain(103);
    expect(FILE).toMatch(/^0104_/);
  });

  it("touches ONLY the one index, no tables, RPCs, policies, or env", () => {
    expect(CODE).not.toMatch(/alter table|create table|create policy|drop policy|create or replace function|drop function/i);
    expect(CODE).not.toMatch(/STRIPE_ALLOW_LIVE_MODE/);
    expect(CODE).not.toMatch(/insert into|update |delete from|truncate/i);
  });
});

describe("0104: index rescope", () => {
  it("drops the old per-pair index and recreates it per (pair, mode)", () => {
    expect(CODE).toMatch(/drop index if exists public\.client_payment_methods_one_active_per_pair/);
    expect(CODE).toMatch(
      /create unique index client_payment_methods_one_active_per_pair\s*\n?\s*on public\.client_payment_methods \(studio_id, client_id, stripe_livemode\)\s*\n?\s*where status = 'active'/,
    );
  });
});
