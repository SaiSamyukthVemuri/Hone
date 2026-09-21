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
  it("is no longer the repository maximum — 0201 is", () => {
    // HANDED OFF, per CLAUDE.md: only the CURRENT max may assert `isRepoMax`.
    // It moved from here to 0199 when that was authored (#740's reconciliation,
    // preserved), from 0199 to 0200 when WAIT-P1-EXIT authored it, and from
    // 0200 to 0201 when its successor was authored on this branch. Leaving the
    // claim here would have made this file red the moment
    // anything landed above it, which is exactly what happened twice and is why
    // this block moved rather than being deleted.
    //
    // THE LIST IS DERIVED, NOT ENUMERATED BY HAND. `versionsAbove` reads the
    // migrations directory, so the assertion below is the one place a future
    // migration has to be acknowledged in this file — and it is a per-file
    // hand-off, not the eighteen-file sweep CLAUDE.md records.
    expect(isRepoMax(VERSION)).toBe(false);
    expect(versionsAbove(VERSION)).toEqual(["0199", "0200", "0201", "0202"])
  });

  it("IS APPLIED to production, and hosted has not gone backwards past it", () => {
    // 0198 NO LONGER OWNS THE EQUALITY CLAIM. `0199` was applied on 2026-09-18,
    // so this file keeps only a FLOOR -- `hosted >= 0198` -- which is the durable
    // fact about an older applied migration and stays true forever.
    //
    // That is precisely the hand-off the previous revision of this block
    // required: "whoever applies 0199 moves this block: narrow 0198 to a floor
    // the way 0197, 0196 and 0191 were narrowed, and let the new head take
    // equality." Re-asserting equality here would make this file red the moment
    // anything else applies, which is the mechanical sweep CLAUDE.md forbids.
    const state = migrationState();
    expect(Number(state.hosted_migration_max)).toBeGreaterThanOrEqual(Number(VERSION));
    expect(state.pending_migrations).not.toContain(VERSION);
  });

  it("is below the hosted head, with 0199 applied above it", () => {
    // The MIGRATION-FIRST PENDING shape this block previously described ENDED
    // on 2026-09-18, when 0199 was applied and took the chain back to PARITY.
    // 0198 keeps only what stays true forever: something is applied above it,
    // and it is itself no longer pending. The exact hosted-head equality and
    // the next-free claim belong to 0199's own file now.
    const state = migrationState();
    expect(Number(state.hosted_migration_max)).toBeGreaterThan(Number(VERSION));
    expect(state.pending_migrations).not.toContain(VERSION);
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
    // THE CURRENT-BLOCK CLAIM MOVED TO 0199 with the 0199 apply on 2026-09-18.
    // 0198's record is now a PRESERVED "## Previous state" section — historical
    // apply records are never rewritten — so what stays true is that the ledger
    // records 0198 as APPLIED, not that it does so in the current block.
    expect(ledger, "the ledger must still record 0198 as APPLIED").toMatch(
      /0198_waitlist_live_invitation_read\.sql`? \| \*\*APPLIED\*\*/,
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
