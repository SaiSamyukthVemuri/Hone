import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0197 — the server-callable consumed-count gateway.
//
// SOURCE CONTRACT ONLY. The privilege behaviour that actually matters is proved
// against a real database AS service_role in
// tests/db/waitlist-consumed-gateway.db.test.ts — admin-connection tests are
// exactly what missed this defect for 182 passing assertions.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0197";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");
/** Comment- and COMMENT ON-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

describe("0197 position in the chain", () => {
  it("is the repository maximum", () => {
    // Taken over from 0196, per CLAUDE.md: only the CURRENT max asserts this.
    expect(isRepoMax(VERSION)).toBe(true);
  });

  it("has nothing above it", () => {
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("IS APPLIED to production, and is the CURRENT hosted head", () => {
    // 0197 NOW OWNS THE EXACT HOSTED-HEAD CLAIM, handed off from 0196 when this
    // migration was applied on 2026-09-16 under explicit per-change
    // authorization. Equality is a CURRENT claim, so exactly one file may hold
    // it: leaving it on 0196 would have made that file red the moment this one
    // applied, and dropping it would leave the hosted head asserted nowhere.
    //
    // Whoever applies 0198 moves this block: narrow 0197 to a floor the way
    // 0196 and 0191 were narrowed, and let the new head take equality.
    const state = migrationState();
    expect(state.hosted_migration_max).toBe(VERSION);
    expect(state.pending_migrations).not.toContain(VERSION);
  });
});

describe("0197 says nothing about its own hosted status", () => {
  it("makes no hosted claim in its own SQL", () => {
    // The apply record is the ledger's and migration-state.json's job. A
    // migration file that claimed to be applied would be a second, unverifiable
    // source for that fact.
    expect(SQL).not.toMatch(/applied to production/i);
    expect(SQL).not.toMatch(/hosted (head|max)/i);
  });
});

describe("0197 transaction and lock posture", () => {
  it("opens its own transaction and arms a lock timeout inside it", () => {
    // `supabase db push` does not wrap a file in a transaction, so a bare
    // SET LOCAL emits 25P01 and never arms.
    const begin = CODE.indexOf("begin;");
    const lock = CODE.indexOf("set local lock_timeout");
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(CODE.trimEnd().endsWith("commit;")).toBe(true);
  });
});

describe("the gateway's security posture", () => {
  it("is SECURITY DEFINER with a locked search_path", () => {
    // DEFINER is the whole repair: service_role holds EXECUTE on 0192's invoker
    // function but no SELECT on the table it reads.
    expect(CODE).toContain("security definer");
    expect(CODE).toContain("set search_path = pg_catalog, pg_temp");
    expect(CODE).not.toContain("security invoker");
  });

  it("revokes from all four grantees BY NAME, then grants service_role alone", () => {
    const fn = "public.read_waitlist_admission_round_consumed(uuid, uuid)";
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE, `${role} must be revoked by name`).toContain(
        `revoke all privileges on function ${fn} from ${role};`,
      );
    }
    expect(CODE).toMatch(
      new RegExp(`grant\\s+execute on function ${fn.replace(/[()]/g, "\\$&")} to service_role;`),
    );
    // And to NOBODY else. A browser role with EXECUTE on a definer function is a
    // table read with extra steps.
    expect(CODE).not.toMatch(/grant\s+execute on function[^;]*to (anon|authenticated|public)/);
  });

  it("grants NO table privilege to anyone", () => {
    // The point of the gateway is that service_role's direct SELECT stays false.
    expect(CODE).not.toMatch(/grant\s+select/i);
    expect(CODE).not.toMatch(/grant[^;]*on (table )?public\.new_client_waitlist_invitations/i);
    expect(CODE).not.toMatch(/grant[^;]*on (table )?public\.studio_waitlist_admission_rounds/i);
  });

  it("schema-qualifies every object it touches", () => {
    // With search_path pinned to pg_catalog, an unqualified public object would
    // not resolve at all — and a qualified one cannot be shadowed.
    expect(CODE).toContain("public.studio_waitlist_admission_rounds");
    expect(CODE).toContain("public.waitlist_admission_round_consumed(");
  });
});

describe("the gateway delegates and never re-implements", () => {
  it("calls 0192's canonical function", () => {
    expect(CODE).toMatch(
      /v_consumed\s*:=\s*public\.waitlist_admission_round_consumed\(p_round_id\);/,
    );
  });

  it("contains NO copy of the counting algorithm", () => {
    // A second definition of "used" is the competing capacity engine this
    // feature must not become. None of the state columns the canonical count
    // reads may appear in executable text here.
    for (const col of ["redeemed_at", "expired_at", "released_at", "declined_at", "expires_at"]) {
      expect(CODE, `0197 must not re-read ${col}`).not.toContain(col);
    }
    expect(CODE).not.toMatch(/count\(\s*\*\s*\)/);
    expect(CODE).not.toContain("new_client_waitlist_invitations");
  });

  it("validates the studio/round pair before counting anything", () => {
    const check = CODE.indexOf("studio_waitlist_admission_rounds");
    const delegate = CODE.indexOf("waitlist_admission_round_consumed(p_round_id)");
    expect(check).toBeGreaterThan(-1);
    expect(check, "tenancy is decided BEFORE the count").toBeLessThan(delegate);
    expect(CODE).toMatch(/r\.id\s*=\s*p_round_id/);
    expect(CODE).toMatch(/r\.studio_id\s*=\s*p_studio_id/);
  });

  it("returns only an integer, and NULL for a pair it cannot match", () => {
    expect(CODE).toContain("returns integer");
    // Null in, null out; unmatched pair, null out. Null is "no answer", and the
    // application withholds on it — zero would present a full round as free.
    expect(CODE).toMatch(/if p_studio_id is null or p_round_id is null then\s*\n\s*return null;/);
    expect(CODE).toMatch(/\) then\s*\n\s*return null;\s*\n\s*end if;/);
    // No table or row shape is ever returned.
    expect(CODE).not.toMatch(/returns table/i);
    expect(CODE).not.toMatch(/returns setof/i);
  });
});

describe("0192 is not edited", () => {
  it("0197 creates its own object and redefines nothing of 0192's", () => {
    // 0192 is applied and frozen. The gateway is additive.
    expect(CODE).toContain("create or replace function public.read_waitlist_admission_round_consumed");
    expect(CODE).not.toMatch(
      /create or replace function public\.waitlist_admission_round_consumed/,
    );
  });
});
