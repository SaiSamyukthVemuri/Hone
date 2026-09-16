import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// isRepoMax / versionsAbove are deliberately NOT imported any more: the repo-max
// assertion moved to 0197 (see below), and an unused import would fail lint.
import { fileForVersion, migrationState } from "./helpers/migration-state";

// 0196 — the recorded delivery outcome.
//
// SOURCE CONTRACT ONLY. Behaviour is proved against a real database in
// tests/db/waitlist-invitation-delivery-outcome.db.test.ts; this pins what is
// decidable from the migration text.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0196";
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)), "utf8");
/**
 * Comment-stripped, so a rule NAMED in prose never satisfies an assertion — and
 * `COMMENT ON` statements are stripped too. Their text is a STRING LITERAL, not
 * a comment, so the function's own documentation ("stores no token, proof...")
 * would otherwise trip the very prohibition it describes.
 */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

describe("0196 position in the chain", () => {
  // THE REPO-MAX CLAIM HAS MOVED TO 0197, which is the handoff the previous
  // comment here asked for ("whoever adds 0197 moves it") and the rule CLAUDE.md
  // states: only the CURRENT maximum migration's own test may assert isRepoMax,
  // because otherwise every landing migration reds an older file and the sweep
  // gets missed. tests/migrations/0197-waitlist-consumed-count-gateway.test.ts
  // now carries it. Nothing else in this file changed -- 0196 keeps every claim
  // it makes about itself, including the hosted-head claim below, which is still
  // true: 0197 is authored and PENDING, not applied.

  it("IS APPLIED to production, and is the CURRENT hosted head", () => {
    // 0196 OWNS THE EXACT HOSTED-HEAD CLAIM, and owning it is the point.
    //
    // 0192-0196 were applied to production on 2026-09-15. Before that, 0191's
    // file asserted `hosted_migration_max === '0191'`; it now keeps only a
    // FLOOR (`hosted >= 0191`), which is the durable fact about an older
    // applied migration and stays true forever. Equality is a CURRENT claim, so
    // exactly one file may hold it — and it has to be this one, because leaving
    // it on 0191 would have made that file red the moment anything else applied,
    // and dropping it entirely would leave the hosted head asserted nowhere.
    //
    // Whoever applies 0197 moves this block: narrow 0196 to a floor the way
    // 0191 was narrowed, and let the new head take equality. That hand-off is
    // the rule, not a courtesy.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.pending_migrations).not.toContain(VERSION);
  });
});

describe("transaction posture", () => {
  it("opens its own transaction and bounds the lock", () => {
    expect(CODE).toMatch(/^\s*begin;/m);
    expect(CODE).toMatch(/set local lock_timeout/);
    expect(CODE).toMatch(/^\s*commit;/m);
  });
});

describe("the fact, and what it is NOT allowed to carry", () => {
  it("adds exactly the two delivery columns to the EXISTING invitations table", () => {
    expect(CODE).toMatch(/alter table public\.new_client_waitlist_invitations/);
    expect(CODE).toMatch(/add column if not exists delivery_disposition text/);
    expect(CODE).toMatch(/add column if not exists delivery_recorded_at timestamptz/);
    // No new table, and no events table.
    expect(CODE).not.toMatch(/create table/i);
  });

  it("stores NO token, proof, recipient, payload or provider credential", () => {
    for (const forbidden of [
      /token/i, /proof/i, /capability/i, /challenge/i,
      /recipient/i, /email_body/i, /subject/i, /provider_message/i, /api_key/i,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("confines the disposition to the application's own three words", () => {
    expect(CODE).toMatch(/in \('accepted', 'refused', 'unknown'\)/);
    expect(CODE).not.toMatch(/'delivered'|'read'|'opened'/);
  });

  it("keeps NEVER-RECORDED representable and distinct from unknown", () => {
    // All-or-nothing: both null, or both present. A disposition with no
    // timestamp cannot be ordered; a timestamp with none says nothing.
    expect(CODE).toMatch(/delivery_disposition is null and delivery_recorded_at is null/);
    expect(CODE).toMatch(/delivery_disposition is not null and delivery_recorded_at is not null/);
    // The columns are nullable — no default that would manufacture a verdict.
    expect(CODE).not.toMatch(/delivery_disposition text not null|default 'unknown'/);
  });
});

describe("the write is governed and cannot widen authority", () => {
  it("first observation wins; a contradiction is refused without writing", () => {
    expect(CODE).toMatch(/'unchanged'/);
    expect(CODE).toMatch(/'conflict'/);
    // The UPDATE only ever fills an EMPTY slot.
    expect(CODE).toMatch(/and i\.delivery_disposition is null/);
  });

  it("scopes by BOTH id and studio, so another studio's row is not found", () => {
    expect(CODE).toMatch(/where i\.id = p_invitation_id\s*and i\.studio_id = p_studio_id/);
    expect(CODE).toMatch(/'not_found'/);
  });

  it("touches ONLY the two delivery columns — no lifecycle, no status", () => {
    const update = CODE.slice(CODE.indexOf("update public.new_client_waitlist_invitations"));
    const setClause = update.slice(0, update.indexOf("where"));
    expect(setClause).toMatch(/delivery_disposition = p_disposition/);
    expect(setClause).toMatch(/delivery_recorded_at = clock_timestamp\(\)/);
    for (const forbidden of [/redeemed_at/, /expired_at/, /released_at/, /declined_at/, /status/]) {
      expect(setClause, String(forbidden)).not.toMatch(forbidden);
    }
    // And it never reaches the entries table at all.
    expect(CODE).not.toMatch(/update public\.new_client_waitlist_entries/);
  });

  it("is security definer with a pinned search_path", () => {
    expect(CODE).toMatch(/security definer/);
    expect(CODE).toMatch(/set search_path = pg_catalog, pg_temp/);
  });
});

describe("grants", () => {
  for (const role of ["public", "anon", "authenticated", "service_role"]) {
    it(`revokes execute from ${role} by name`, () => {
      // Supabase grants EXECUTE to anon, authenticated AND service_role at
      // create time; 0129 missed `anon` and 0164 missed `service_role`.
      expect(CODE).toMatch(
        new RegExp(`revoke execute on function public\\.record_waitlist_invitation_delivery\\(uuid, uuid, text\\) from ${role};`),
      );
    });
  }

  it("grants execute to service_role only", () => {
    const grants = CODE.match(/grant\s+execute on function[^;]+;/g) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/to service_role;/);
  });

  it("grants the practitioner READ at column level, not table level", () => {
    expect(CODE).toMatch(
      /grant select \(delivery_disposition, delivery_recorded_at\)\s*on public\.new_client_waitlist_invitations to authenticated;/,
    );
    // No table-wide grant that would expose token_hash or the proof columns.
    expect(CODE).not.toMatch(/grant select on public\.new_client_waitlist_invitations to/);
    expect(CODE).not.toMatch(/grant (insert|update|delete)/i);
  });

  it("creates no policy — the existing owner-select policy already scopes rows", () => {
    expect(CODE).not.toMatch(/create policy/i);
  });
});
