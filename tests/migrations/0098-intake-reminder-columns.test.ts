import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// PR #306. SQL-text pin for migration 0098 (intake-reminder idempotency columns
// + claim/record RPC branches). Behavioral proof runs in CI's db-integration
// lane (apply + type regen); this pins the migration shape so it can't regress.

const SQL = readFileSync(
  join(process.cwd(), "supabase/migrations/0098_intake_reminder_columns.sql"),
  "utf8",
);
// Strip -- comments so the explanatory header (which names what we avoid)
// doesn't satisfy or trip the negative greps.
const CODE = SQL.split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");

describe("0098 adds the 6 intake-reminder columns (additive/backfill-safe)", () => {
  for (const kind of ["7d", "3d"]) {
    it(`intake_reminder_${kind}: sent_at + send_attempts(default 0) + claimed_at`, () => {
      expect(SQL).toMatch(
        new RegExp(`add column if not exists intake_reminder_${kind}_sent_at timestamptz`),
      );
      expect(SQL).toMatch(
        new RegExp(
          `add column if not exists intake_reminder_${kind}_send_attempts integer not null default 0`,
        ),
      );
      expect(SQL).toMatch(
        new RegExp(`add column if not exists intake_reminder_${kind}_claimed_at timestamptz`),
      );
    });
  }

  it("adds the two partial window indexes", () => {
    expect(SQL).toMatch(/appointments_intake_reminder_7d_window_idx/);
    expect(SQL).toMatch(/appointments_intake_reminder_3d_window_idx/);
    // Same predicate shape as the 0025 email reminder indexes.
    expect(SQL).toMatch(/intake_reminder_7d_sent_at is null[\s\S]*?status = 'confirmed'[\s\S]*?intake_reminder_7d_send_attempts < 3/);
  });
});

describe("0098 extends the claim/record RPCs (existing branches intact)", () => {
  it("claim_email_send + record_email_result gain intake_reminder_7d / _3d branches", () => {
    expect(SQL).toMatch(/elsif p_email_type = 'intake_reminder_7d' then/);
    expect(SQL).toMatch(/elsif p_email_type = 'intake_reminder_3d' then/);
    // The new claim branch atomically increments + stamps claimed_at.
    expect(SQL).toMatch(/intake_reminder_7d_send_attempts = intake_reminder_7d_send_attempts \+ 1/);
    expect(SQL).toMatch(/intake_reminder_3d_claimed_at    = v_now/);
  });

  it("keeps the existing confirmation / reminder_24h / reminder_2h branches byte-for-byte", () => {
    expect(SQL).toMatch(/if p_email_type = 'confirmation' then/);
    expect(SQL).toMatch(/elsif p_email_type = 'reminder_24h' then/);
    expect(SQL).toMatch(/elsif p_email_type = 'reminder_2h' then/);
    // The exact existing claim line for reminder_24h is reproduced.
    expect(SQL).toMatch(/set reminder_24h_send_attempts = reminder_24h_send_attempts \+ 1,/);
    // record_email_result existing branch reproduced.
    expect(SQL).toMatch(/set reminder_24h_sent_at    = case when p_success then now\(\) else reminder_24h_sent_at end,/);
  });

  it("re-asserts service_role-only grants", () => {
    expect(SQL).toMatch(/grant execute on function public\.claim_email_send\(uuid, text\) to service_role/);
    expect(SQL).toMatch(/grant execute on function public\.record_email_result\(uuid, text, boolean\) to service_role/);
  });
});

describe("0098 is safe: no RLS / enum / destructive DDL", () => {
  it("no RLS / policy / grant-to-authenticated change", () => {
    expect(CODE).not.toMatch(/create policy|alter policy|drop policy|enable row level/i);
    expect(CODE).not.toMatch(/to authenticated|to anon/);
  });
  it("no enum change, no destructive DDL", () => {
    expect(CODE).not.toMatch(/create type|alter type|drop type/i);
    expect(CODE).not.toMatch(/drop column|drop table|drop index|alter column .* type/i);
  });
  it("columns are additive (add column if not exists)", () => {
    expect(SQL).toMatch(/add column if not exists/);
  });
});
