import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0198 — WAIT-LIVE-READ-01. One grant, and nothing else.
//
// SOURCE CONTRACT ONLY. Behaviour is proved against a real database in
// tests/db/waitlist-live-invitation-read.db.test.ts.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0198";
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", fileForVersion(VERSION)), "utf8");
/** Comment- and COMMENT ON-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

describe("0198 position in the chain", () => {
  it("is no longer the repository maximum — 0199 is", () => {
    // HANDED OFF, per CLAUDE.md: only the CURRENT max may assert `isRepoMax`,
    // and 0199 now holds it. Leaving the claim here would have made this file
    // red the moment 0199 was authored, which is exactly what happened and is
    // why this block moved rather than being deleted.
    expect(isRepoMax(VERSION)).toBe(false);
    expect(versionsAbove(VERSION)).toEqual(["0199"]);
  });

  it("IS APPLIED to production, and is the CURRENT hosted head", () => {
    // 0198 NOW OWNS THE EXACT HOSTED-HEAD CLAIM, handed off from 0197 when this
    // migration was applied to production on 2026-09-16 under explicit
    // per-change authorization: one column grant, `select (declined_at)`,
    // verified read-only against the canonical Hone production project and
    // recorded in docs/production/migration-state.json plus the ledger's
    // current block.
    //
    // An earlier revision of this file said 0197 kept the hosted-head claim
    // "because 0198 is authored and NOT applied". That was true when it was
    // written and stopped being true when the apply landed.
    //
    // Equality is a CURRENT claim, so exactly one file may hold it: leaving it
    // on 0197 would have made that file red the moment this one applied, and
    // dropping it would leave the hosted head asserted nowhere. 0197 was
    // correspondingly narrowed to a floor, the way 0196 and 0191 were.
    //
    // Whoever applies 0199 moves this block: narrow 0198 to a floor the way
    // 0197, 0196 and 0191 were narrowed, and let the new head take equality.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.pending_migrations).not.toContain(VERSION);
  });

  it("is the HOSTED head while 0199 is authored and PENDING", () => {
    // Back to the ordinary MIGRATION-FIRST PENDING shape this file described
    // before the 0198 apply: repo one above hosted, with the new number named
    // as the pending suffix.
    //
    // 0198 KEEPS the hosted-head claim above, because it remains the applied
    // head — 0199 is authored here and deliberately NOT applied. The equality
    // block moves only when 0199 is applied under its own authorization.
    const state = migrationState();
    expect(state.pending_migrations).toEqual(["0199"]);
    expect(state.repo_equals_hosted).toBe(false);
    expect(state.next_free_migration).toBe("0200");
  });
});

describe("0198 is APPLIED, and therefore FROZEN", () => {
  it("still hashes to the checksum that was reviewed, authorized and applied", () => {
    // THE BYTE-IDENTITY LINK. This one value ties together four things that can
    // otherwise drift apart: what was reviewed on #713, what the operator
    // authorized, what production actually ran, and what this repository still
    // holds on disk. An applied migration is FROZEN -- its recorded checksum has
    // to keep describing the file. Behaviour changes need a NEW migration (0199),
    // never an edit here.
    //
    // The same hash was recomputed from the file immediately before the write,
    // and again during the post-apply reconciliation; production's own migration
    // history was additionally read back and its recorded statements compared
    // against this file character-for-character.
    expect(
      createHash("sha256").update(SQL).digest("hex"),
      "0198 is APPLIED in production with this checksum. Never edit an applied " +
        "migration -- write a new one (0199).",
    ).toBe("91072df94586e9f78536962ddc8c4c601b080b4e6237374a5315e218dbc0c792");
  });

  it("is recorded in the ledger under its COMPLETE sha256, and as APPLIED", () => {
    // A truncated or mis-transcribed hash is not a record. The 0197 apply was
    // refused once for exactly that -- a 65-character hash -- and the gate did
    // its job, so the full value must be present verbatim.
    const ledger = readFileSync(path.join(ROOT, "docs/production/migration-ledger.md"), "utf8");
    expect(ledger, "the ledger must carry 0198's COMPLETE sha256").toContain(
      "91072df94586e9f78536962ddc8c4c601b080b4e6237374a5315e218dbc0c792",
    );
    expect(ledger, "the ledger's current block must record 0198 as APPLIED").toMatch(
      /## Current state[\s\S]{0,4000}0198_waitlist_live_invitation_read\.sql`? \| \*\*APPLIED\*\*/,
    );
  });
});

describe("transaction posture", () => {
  it("opens its own transaction and bounds the lock", () => {
    expect(CODE).toMatch(/^\s*begin;/m);
    expect(CODE).toMatch(/set local lock_timeout/);
    expect(CODE).toMatch(/^\s*commit;/m);
  });
});

describe("it is EXACTLY one column grant", () => {
  it("grants SELECT on declined_at to authenticated, column-scoped", () => {
    expect(CODE).toMatch(
      /grant select \(declined_at\)\s*on public\.new_client_waitlist_invitations to authenticated;/,
    );
  });

  it("grants nothing else, to anyone", () => {
    const grants = CODE.match(/grant[^;]+;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/to authenticated;/);
    expect(CODE).not.toMatch(/to (anon|service_role|public)\b/);
  });

  it("is NOT a table-wide grant and NOT a SELECT *", () => {
    expect(CODE).not.toMatch(/grant select on public\./);
    expect(CODE).not.toMatch(/select \*/i);
  });

  it("exposes NO credential or authority column", () => {
    for (const forbidden of [
      /token_hash/, /proof_challenge/, /proof_capability/,
      /scope_service_id/, /scope_start_date/, /scope_end_date/,
      /scope_allowed_weekdays/, /admission_round_id/,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("adds no schema, no authority object and no mutation path", () => {
    for (const forbidden of [
      /create table/i, /alter table/i, /add column/i, /drop column/i,
      /create (or replace )?function/i, /create policy/i, /alter policy/i,
      /create (unique )?index/i, /create trigger/i,
      /insert into/i, /update /i, /delete from/i, /revoke/i,
    ]) {
      expect(CODE, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it("touches only the invitations table", () => {
    const tables = CODE.match(/public\.[a-z_]+/g) ?? [];
    expect([...new Set(tables)]).toEqual(["public.new_client_waitlist_invitations"]);
  });
});
