import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// PR #189. Migration 0080 adds the atomic claim for appointment email
// sends, mirroring the SMS claim from 0049. These tests pin the SQL
// shape that makes duplicate cron passes unable to double-send: the
// claim is a single conditional UPDATE gated on sent-is-null,
// attempts-under-cap, and no-fresh-claim, so exactly one of two
// overlapping runs can win it.

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    "../../supabase/migrations/0080_email_send_claims.sql",
  ),
  "utf8",
);

function codeOnly(src: string): string {
  return src
    .split("\n")
    .filter((line) => !/^\s*--/.test(line))
    .join("\n");
}
const SQL = codeOnly(MIGRATION);

describe("0080: claim columns", () => {
  it("adds the three claim columns idempotently", () => {
    expect(SQL).toMatch(
      /add column if not exists confirmation_claimed_at timestamptz/,
    );
    expect(SQL).toMatch(
      /add column if not exists reminder_24h_claimed_at timestamptz/,
    );
    expect(SQL).toMatch(
      /add column if not exists reminder_2h_claimed_at timestamptz/,
    );
  });
});

describe("0080: claim_email_send atomicity (duplicate runs cannot both win)", () => {
  const arms = [
    {
      type: "reminder_24h",
      attempts: "reminder_24h_send_attempts",
      sent: "reminder_24h_sent_at",
      claimed: "reminder_24h_claimed_at",
    },
    {
      type: "reminder_2h",
      attempts: "reminder_2h_send_attempts",
      sent: "reminder_2h_sent_at",
      claimed: "reminder_2h_claimed_at",
    },
    {
      type: "confirmation",
      attempts: "confirmation_send_attempts",
      sent: "confirmation_sent_at",
      claimed: "confirmation_claimed_at",
    },
  ] as const;

  for (const arm of arms) {
    it(`${arm.type}: single conditional UPDATE with all three guards`, () => {
      // The whole safety property lives in one statement: increment +
      // stamp WHERE unsent AND under-cap AND not freshly claimed. A
      // second overlapping run sees claimed_at freshly stamped and its
      // UPDATE matches zero rows -> claim returns false -> no send.
      const armRe = new RegExp(
        `${arm.attempts} = ${arm.attempts} \\+ 1,\\s*` +
          `${arm.claimed}\\s*= v_now\\s*` +
          `where id = p_appointment_id\\s*` +
          `and ${arm.sent} is null\\s*` +
          `and ${arm.attempts} < 3\\s*` +
          `and \\(${arm.claimed} is null\\s*` +
          `or ${arm.claimed} < v_stale_cutoff\\)`,
      );
      expect(SQL).toMatch(armRe);
    });
  }

  it("claim returns true only when exactly one row was updated", () => {
    expect(SQL).toMatch(/get diagnostics v_updated = row_count/);
    expect(SQL).toMatch(/return v_updated = 1;/);
  });

  it("stale-claim window is 5 minutes (crashed sender recovery)", () => {
    expect(SQL).toMatch(
      /v_stale_cutoff timestamptz := v_now - interval '5 minutes'/,
    );
  });

  it("unknown email type raises (caller bugs fail loudly)", () => {
    expect(SQL).toMatch(/raise exception 'Unknown email_type: %'/);
  });
});

describe("0080: record_email_result", () => {
  it("stamps sent_at only on success and always clears the claim (24h arm)", () => {
    expect(SQL).toMatch(
      /reminder_24h_sent_at\s*= case when p_success then now\(\) else reminder_24h_sent_at end,\s*reminder_24h_claimed_at = null/,
    );
  });

  it("does NOT increment attempts (the claim already did)", () => {
    const recordBody = SQL.slice(
      SQL.indexOf("create or replace function public.record_email_result"),
    );
    expect(recordBody).not.toMatch(/_send_attempts \+ 1/);
  });
});

describe("0080: security posture", () => {
  it("both functions are SECURITY DEFINER with a locked search_path", () => {
    const definers = SQL.match(/security definer\s*\nset search_path = public/g) ?? [];
    expect(definers.length).toBe(2);
  });

  it("revokes default execute from public, anon, authenticated", () => {
    expect(SQL).toMatch(
      /revoke all on function public\.claim_email_send\(uuid, text\) from public, anon, authenticated;/,
    );
    expect(SQL).toMatch(
      /revoke all on function public\.record_email_result\(uuid, text, boolean\) from public, anon, authenticated;/,
    );
  });

  it("grants execute to service_role ONLY", () => {
    expect(SQL).toMatch(
      /grant execute on function public\.claim_email_send\(uuid, text\) to service_role;/,
    );
    expect(SQL).toMatch(
      /grant execute on function public\.record_email_result\(uuid, text, boolean\) to service_role;/,
    );
    // No grant line for these functions names anything but service_role.
    const grants = SQL.match(/grant execute on function [^;]+;/g) ?? [];
    for (const g of grants) {
      expect(g).toMatch(/to service_role;$/);
    }
  });

  it("does not touch record_email_attempt (0028 unclaimed paths unchanged)", () => {
    expect(SQL).not.toMatch(/create or replace function public\.record_email_attempt/);
  });

  it("no payment / Stripe surface", () => {
    expect(SQL).not.toMatch(/stripe|payment_charge|manual_fee/i);
  });
});
