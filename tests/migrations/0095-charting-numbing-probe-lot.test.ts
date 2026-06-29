import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #279. SQL-text pin for migration 0095 (charting numbing + probe-lot
// confirmation). Behavioral proof is in tests/db/charting-numbing-probe-lot.db.test.ts
// (db lane); this pins the migration shape and that it changes nothing else.

const SQL = readFileSync(
  join(
    process.cwd(),
    "supabase/migrations/0095_charting_numbing_and_probe_lot_confirm.sql",
  ),
  "utf8",
);

describe("0095 adds the two charting columns (additive, safely defaulted)", () => {
  it("adds numbing_status + probe_lot_confirmed if not exists", () => {
    expect(SQL).toMatch(
      /alter table public\.session_blocks[\s\S]*add column if not exists numbing_status text/,
    );
    expect(SQL).toMatch(
      /add column if not exists probe_lot_confirmed boolean not null default false/,
    );
  });
  it("constrains numbing_status to NULL or none/used", () => {
    expect(SQL).toMatch(
      /check \(numbing_status is null or numbing_status in \('none', 'used'\)\)/,
    );
  });
  it("is idempotent (drop+add the CHECK; add column if not exists)", () => {
    expect(SQL).toMatch(
      /drop constraint if exists session_blocks_numbing_status_check/,
    );
  });
  it("includes a production preflight note", () => {
    expect(SQL).toMatch(/PREFLIGHT/);
  });
});

describe("0095 changes nothing else (no RLS / payment / tenancy / storage)", () => {
  it("only touches session_blocks", () => {
    const alters = SQL.match(/alter table\s+public\.[a-z_]+/gi) ?? [];
    for (const a of alters) {
      expect(a.toLowerCase()).toBe("alter table public.session_blocks");
    }
  });
  it("creates/drops no policy and no FK, grants no anon/public access", () => {
    expect(SQL).not.toMatch(/create policy|drop policy/i);
    expect(SQL).not.toMatch(/to anon|to public/i);
    expect(SQL).not.toMatch(/enable row level security|disable row level security/i);
    expect(SQL).not.toMatch(/foreign key|references /i);
  });
  it("touches no payment / live-mode / storage surface", () => {
    expect(SQL).not.toMatch(/paymentIntents|STRIPE_ALLOW_LIVE_MODE|stripe_livemode/i);
    expect(SQL).not.toMatch(/treatment_images|storage\./i);
  });
  it("backfills nothing (legacy rows keep the safe defaults)", () => {
    expect(SQL).not.toMatch(/\bupdate\s+public\./i);
  });
});
