import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  versionsAbove,
} from "./helpers/migration-state";

// 0192 — COMMS-01B2: the outbound sender lookup.
//
// SOURCE CONTRACT. This file proves what the migration SAYS. The behavioural
// half — that anon and authenticated are actually refused EXECUTE, that
// service_role still cannot read the table, that only ACTIVE resolves — lives
// in tests/db/studio-sms-sender-outbound-lookup.db.test.ts and can only be
// demonstrated by PostgreSQL. Neither is sufficient alone: SQL text cannot
// prove a grant fires, and a behavioural test cannot prove a revoke line was
// WRITTEN rather than inherited from Supabase's create-time defaults — which
// is precisely the 0129/0164 failure class.
//
// THE NAMED MUTATIONS THIS FILE EXISTS TO CATCH:
//   * granting SELECT on studio_sms_senders to make the lookup "work" —
//     that would dissolve 0191's provider-identifier boundary, and the
//     no-table-grant assertion fails;
//   * returning a scalar instead of a set, which would silently pick a row
//     by order if the one-live-per-studio invariant were ever violated;
//   * widening the returned columns to include the claim key, the lease, or
//     phone_number_sid;
//   * forgetting to revoke from any one role by name.

const VERSION = "0192";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(
  path.resolve(__dirname, "../../supabase/migrations", FILE),
  "utf8",
);
const FN = "resolve_active_studio_sms_sender";

describe("0192 — identity and position", () => {
  it("is named for what it adds", () => {
    expect(FILE).toBe("0192_studio_sms_sender_outbound_lookup.sql");
  });

  it("is the current repository maximum", () => {
    // Per CLAUDE.md only the CURRENT max asserts this, so a future migration
    // does not turn this file red. Whoever adds 0193 moves it.
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("opens its own transaction and bounds the lock", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms.
    expect(SQL).toMatch(/^begin;/m);
    expect(SQL).toMatch(/^commit;/m);
    expect(SQL).toMatch(/set local lock_timeout/);
  });
});

describe("0192 — the lookup returns the minimum authority, and no more", () => {
  it("returns a SET, not a scalar — no pick-first by row order", () => {
    // A scalar return would answer with whichever row PostgreSQL reached
    // first if one-live-per-studio were ever violated.
    expect(SQL).toMatch(/returns table \(messaging_service_sid text\)/);
    expect(SQL).not.toMatch(/returns text\s*$/m);
  });

  it("selects only the messaging service SID", () => {
    expect(SQL).toMatch(/select\s+s\.messaging_service_sid/);
  });

  it("never returns a provisioning internal or another studio's row", () => {
    // Scoped to the EXECUTABLE body between the dollar quotes. The prose around
    // it names these columns precisely to say they are excluded, so scanning
    // the comments would fail on the explanation rather than on the code.
    const body = SQL.slice(SQL.indexOf("as $$"), SQL.indexOf("$$;"));
    for (const forbidden of [
      "provisioning_claim_key",
      "provisioning_claim_at",
      "provisioning_claim_by_practitioner_id",
      "phone_number_sid",
    ]) {
      expect(body, `${forbidden} must not be returned`).not.toContain(forbidden);
    }
  });

  it("resolves ACTIVE only — no other status may route a live message", () => {
    expect(SQL).toMatch(/and s\.status = 'active'/);
    // 'suspended' is accepted by the INBOUND resolver in 0191 (a callback must
    // still be attributable) but must never send an outbound message.
    const body = SQL.slice(SQL.indexOf("as $$"), SQL.indexOf("$$;"));
    expect(body).not.toMatch(/status in \(/);
    expect(body).not.toContain("'suspended'");
  });

  it("is filtered by the caller-supplied studio id", () => {
    expect(SQL).toMatch(/where s\.studio_id = p_studio_id/);
  });
});

describe("0192 — the routing-alert dedupe index is NARROW", () => {
  it("is a partial unique index over UNRESOLVED rows only", () => {
    // Partial on resolved_at is null is what makes resolution RE-ARM the alert:
    // a resolved row no longer collides, so a recurrence is reported again.
    expect(SQL).toMatch(/create unique index if not exists ops_alerts_sms_routing_open_uniq/);
    expect(SQL).toMatch(/on public\.ops_alerts \(studio_id, event\)/);
    expect(SQL).toMatch(/where resolved_at is null/);
  });

  it("is scoped to the three SMS routing events and nothing else", () => {
    // The whole point of the narrowing: no other ops_alerts class may acquire a
    // uniqueness rule it never had.
    const idx = SQL.slice(SQL.indexOf("ops_alerts_sms_routing_open_uniq"));
    for (const ev of [
      "sms_sender_not_active_for_studio",
      "sms_sender_ambiguous",
      "sms_sender_read_failed",
    ]) {
      expect(idx).toContain(ev);
    }
    expect(idx).toMatch(/event in \(/);
  });

  it("adds NO uniqueness rule to ops_alerts beyond that one partial index", () => {
    const opsIdx = SQL.match(/create unique index[^;]*public\.ops_alerts[^;]*;/gi) ?? [];
    expect(opsIdx).toHaveLength(1);
    // And it must not be a table-wide constraint, which would change unrelated
    // alert semantics.
    expect(SQL).not.toMatch(/alter table public\.ops_alerts[^;]*add constraint[^;]*unique/i);
  });

  it("documents that a conflict means ALREADY REPORTED, not a failure", () => {
    expect(SQL).toMatch(/comment on index public\.ops_alerts_sms_routing_open_uniq/);
    expect(SQL).toMatch(/ALREADY REPORTED/);
  });
});

describe("0192 — hardening follows the repository idiom", () => {
  it("is SECURITY DEFINER with a fixed search_path", () => {
    expect(SQL).toMatch(/security definer/);
    expect(SQL).toMatch(/set search_path = pg_catalog, pg_temp/);
  });

  it("is stable, not volatile", () => {
    expect(SQL).toMatch(/\bstable\b/);
  });

  it("fully qualifies the relation it reads", () => {
    expect(SQL).toMatch(/from public\.studio_sms_senders/);
  });
});

describe("0192 — privileges are enumerated by name", () => {
  // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated
  // AND service_role at create time. A denylist that forgets one leaves it
  // granted — missed for `anon` in 0129 and for `service_role` in 0164.
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    it(`revokes EXECUTE from ${role} by name`, () => {
      expect(SQL).toContain(
        `revoke execute on function public.${FN}(uuid) from ${role};`,
      );
    });
  }

  it("grants EXECUTE to service_role, and to nobody else", () => {
    expect(SQL).toContain(
      `grant execute on function public.${FN}(uuid) to service_role;`,
    );
    const grants = SQL.match(/^grant execute on function[^\n]*$/gm) ?? [];
    expect(grants).toHaveLength(1);
    for (const g of grants) {
      expect(g).toContain("to service_role;");
    }
  });

  it("ADDS NO TABLE GRANT — 0191's boundary is preserved, not widened", () => {
    // The whole point: the lookup exists so that nobody has to grant
    // service_role a read on studio_sms_senders.
    expect(SQL).not.toMatch(/grant\s+select[^;]*on\s+public\.studio_sms_senders/i);
    expect(SQL).not.toMatch(/grant\s+all[^;]*on\s+public\.studio_sms_senders/i);
  });

  it("carries a comment stating it does not widen 0191", () => {
    expect(SQL).toMatch(/comment on function public\.resolve_active_studio_sms_sender/);
    expect(SQL).toMatch(/service_role only/);
  });
});
