import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileForVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

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
  it("is the repository maximum", () => {
    // Taken over from 0197, per CLAUDE.md: only the CURRENT max asserts this.
    // 0197 keeps the HOSTED-head claim, because 0198 is authored and NOT applied.
    expect(isRepoMax(VERSION)).toBe(true);
  });
  it("has nothing above it", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
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
