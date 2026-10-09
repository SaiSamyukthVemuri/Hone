import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0207 — SMS-01 invitation claim: claimers of one invitation run one
// at a time. SOURCE CONTRACT.
//
// The behaviour is proved by real two-session races, including a negative
// control running 0206's exact function, in
// tests/db/sms-delivery-foundation.db.test.ts ("claimers of one invitation run
// one at a time (0207)"). This file pins what that cannot see:
// - 0207 is a forward correction that leaves the APPLIED 0206 byte-identical;
// - it redefines exactly one function, and changes only its row lock;
// - it re-asserts the revokes and the service_role grant by name, writes no
//   rows, and changes no table, index, constraint or trigger.
// ===========================================================================

const VERSION = "0207";
const FILE = "0207_sms_invitation_claim_serialized.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const SQL = readFileSync(path.join(MIGRATIONS, FILE), "utf8");
const SQL_0206 = readFileSync(path.join(MIGRATIONS, "0206_sms_delivery_foundation.sql"), "utf8");
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");

const FN = "claim_waitlist_invitation_sms";
const SIGNATURE = `${FN}(uuid, uuid)`;

/** The function's full definition, from its create statement to the closing $$;. */
function definition(sql: string): string {
  const start = sql.indexOf(`create or replace function public.${FN}(`);
  expect(start, `no ${FN} definition`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + "$$;".length);
}
const normalise = (sql: string) => stripComments(sql).replace(/\s+/g, " ").trim();

describe("0207 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. 0206 handed the claim over when this file was authored.
    expect(isRepoMax(VERSION), "0207 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0207").toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0207 corrects forward and leaves the applied 0206 untouched", () => {
  it("0206 is byte-identical to the file applied to production on 2026-10-09", () => {
    expect(createHash("sha256").update(SQL_0206, "utf8").digest("hex")).toBe(
      "e3cdaf222f39fc34fe04f7bf93cdbbef62f0b08c2b1033fd9c44010cda86b0ab",
    );
  });

  it("opens with begin + lock_timeout and closes with commit", () => {
    const statements = TOP_LEVEL.trim();
    expect(statements.startsWith("begin;")).toBe(true);
    expect(statements).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(statements.endsWith("commit;")).toBe(true);
  });

  it("redefines exactly one function: the invitation claim, with 0206's signature and return table", () => {
    const creates = [...CODE.matchAll(/create\s+(or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi)].map((m) => m[2]);
    expect(creates).toEqual([FN]);
    const head = (sql: string) => normalise(definition(sql)).split(" as $$")[0];
    expect(head(SQL)).toBe(head(SQL_0206));
  });

  it("the body is 0206's, except the row lock: FOR SHARE becomes FOR NO KEY UPDATE", () => {
    const before = normalise(definition(SQL_0206));
    const after = normalise(definition(SQL));
    expect(before).toMatch(/ for share; /);
    expect(after).not.toMatch(/ for share; /);
    expect(after).toMatch(/ for no key update; /);
    expect(after).toBe(before.replace(" for share; ", " for no key update; "));
  });

  it("reads the clock inside the lock with clock_timestamp(), never now()", () => {
    const body = normalise(definition(SQL));
    const lock = body.indexOf(" for no key update; ");
    const clock = body.indexOf("clock_timestamp()");
    expect(lock).toBeGreaterThan(-1);
    expect(clock).toBeGreaterThan(lock);
    expect(body).not.toMatch(/\bnow\(\)/);
  });

  it("re-asserts every revoke BY NAME, then grants to service_role only", () => {
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(TOP_LEVEL).toMatch(
        new RegExp(`revoke execute on function public\\.${FN}\\(uuid, uuid\\) from ${role};`),
      );
    }
    const grants = [...TOP_LEVEL.matchAll(/grant\s+[^;]+;/gi)].map((m) => m[0].replace(/\s+/g, " "));
    expect(grants).toEqual([`grant execute on function public.${SIGNATURE} to service_role;`]);
  });

  it("corrects the catalog comment, which still described FOR SHARE", () => {
    const comment = TOP_LEVEL.match(new RegExp(`comment on function public\\.${FN}\\(uuid, uuid\\) is\\s+'([\\s\\S]*?)';`));
    expect(comment, "no corrected comment").not.toBeNull();
    expect(comment![1]).toMatch(/FOR NO KEY UPDATE/);
    expect(comment![1]).not.toMatch(/FOR SHARE/);
  });

  it("writes no rows and changes no table, column, index, constraint or trigger", () => {
    expect(TOP_LEVEL).not.toMatch(/\b(insert\s+into|update\s+\w|delete\s+from|truncate)\b/i);
    expect(TOP_LEVEL).not.toMatch(/\b(create|alter|drop)\s+(table|index|trigger|type|view|sequence)\b/i);
    expect(TOP_LEVEL).not.toMatch(/\badd\s+(column|constraint)\b/i);
  });
});
