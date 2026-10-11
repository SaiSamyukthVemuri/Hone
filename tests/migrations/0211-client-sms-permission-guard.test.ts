import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0211 — G3: the client SMS consent and opt-out guard. SOURCE
// CONTRACT.
//
// Behaviour is proved against a real database, with real roles, in
// tests/db/client-sms-permission-guard.db.test.ts. This file pins what that
// cannot see:
// - the applied migrations it builds on are byte-identical, 0209 and 0210
//   (frozen) included;
// - exactly one function and one trigger, and nothing else: no table, column,
//   constraint, policy or grant change, and no row written;
// - the function is SECURITY INVOKER, so current_user is the real caller, and
//   it keys on the anon / authenticated roles exactly as 0134/0136/0140 do;
// - every rule names its refusal and its errcode.
// ===========================================================================

const VERSION = "0211";
const FILE = "0211_client_sms_permission_guard.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read(FILE);
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const BODY = (CODE.match(/as \$\$([\s\S]*?)\$\$/) ?? ["", ""])[1];
const FN = "clients_sms_permission_guard";

describe("0211 sits correctly in the migration sequence", () => {
  it("is no longer the repository maximum", () => {
    // HANDED OFF, per CLAUDE.md §2: only the CURRENT max may assert
    // `isRepoMax`. It reached this file from 0210's test and moved on to
    // 0212's own test when DELIVERY-EVENTS-01 (#832) stacked on this branch.
    expect(isRepoMax(VERSION)).toBe(false);
    // DERIVED, NOT PINNED: something sits above it, and everything above it is
    // greater. A literal list would be the forbidden pin in other clothes.
    const above = versionsAbove(VERSION);
    expect(above.length, "nothing sits above this older migration").toBeGreaterThan(0);
    expect(
      above.every((v) => Number(v) > Number(VERSION)),
      "versionsAbove returned a version at or below its own",
    ).toBe(true);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0211 leaves every applied migration untouched", () => {
  // The columns it guards (0049), the policies it sits beside (0087), the one
  // SQL writer it must keep working (0204's new-client booking command), and
  // the two migrations that are frozen until their lanes say otherwise.
  const APPLIED: ReadonlyArray<readonly [string, string]> = [
    ["0049_sms_foundation.sql",
     "c329011512969d83b48315db9acad2223127b50cf0ec77d26b6f77b25af74da3"],
    ["0087_clinical_rls_delete_hardening.sql",
     "9c93834e92db5529529f18a53b1058e290c797ec28324326fc3de4cb08a6f795"],
    ["0204_new_client_admission_mode.sql",
     "186fa6cb3154c85d2987f1e75aeee6f7361004f1b535cc44a46a27f96b4db219"],
    ["0209_public_slot_candidate_buffer_window.sql",
     "9fa04999b974d70d838ba27800a22338b1f08fd7977f553dec38fba034e3f877"],
    ["0210_sms_waitlist_join_acknowledgement.sql",
     "b1d33743235644447da41a17778e890c05c14deda6c299303cc5febdceea7157"],
  ];
  for (const [file, sha] of APPLIED) {
    it(`${file} is byte-identical to the applied file`, () => {
      expect(createHash("sha256").update(read(file), "utf8").digest("hex")).toBe(sha);
    });
  }
});

describe("0211 is one guard and nothing else", () => {
  it("opens with begin + lock_timeout and closes with commit", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s+set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
  });

  it("defines exactly one function, the guard", () => {
    const defined = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    expect(defined).toEqual([FN]);
  });

  it("creates exactly one trigger: before INSERT, and before UPDATE OF the four SMS columns", () => {
    const triggers = [...TOP_LEVEL.matchAll(/create\s+trigger\s+(\w+)/gi)].map((m) => m[1]);
    expect(triggers).toEqual([FN]);
    expect(TOP_LEVEL.replace(/\s+/g, " ")).toContain(
      "before insert or update of sms_consent_at, sms_consent_source, sms_opted_out_at, sms_opt_out_source on public.clients for each row execute function public.clients_sms_permission_guard();",
    );
  });

  it("changes no table, column, constraint, policy, index or grant, and writes no row", () => {
    expect(TOP_LEVEL).not.toMatch(/\balter\s+table\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bcreate\s+(table|index|unique|policy)\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bdrop\s+(table|column|policy|index|constraint|function)\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bgrant\b/i);
    expect(TOP_LEVEL).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i);
    // The function body only validates and stamps NEW; it never writes a table.
    expect(BODY).not.toMatch(/\b(insert\s+into|update\s+public\.|delete\s+from|truncate)\b/i);
  });

  it("restates the function's privileges by name, granting none", () => {
    expect(TOP_LEVEL.replace(/\s+/g, " ")).toContain(
      "revoke all privileges on function public.clients_sms_permission_guard() from public, anon, authenticated, service_role;",
    );
  });
});

describe("the guard reads the real caller and names every rule", () => {
  it("is SECURITY INVOKER with a pinned search_path, and returns trigger", () => {
    const head = CODE.slice(CODE.indexOf(`create or replace function public.${FN}(`), CODE.indexOf("as $$"));
    expect(head).toMatch(/returns trigger/);
    expect(head).toMatch(/set search_path = pg_catalog, pg_temp/);
    // DEFINER would make current_user the owner, and every member write would
    // look trusted.
    expect(head).not.toMatch(/security\s+definer/i);
  });

  it("treats anon and authenticated as raw API callers, the 0134/0136/0140 rule", () => {
    expect(BODY).toMatch(/current_user in \('anon', 'authenticated'\)/);
  });

  it("rule 1: a member never records consent, on insert or update (42501)", () => {
    expect(BODY.match(/SMS consent is recorded only by governed paths \(role %\)/g)).toHaveLength(2);
    expect(BODY).toMatch(/errcode = '42501'/);
  });

  it("rule 2: consent evidence is write-once for everyone (check_violation)", () => {
    expect(BODY).toMatch(/consent evidence is write-once; a withdrawal is an opt-out, not an edit'\s+using errcode = 'check_violation'/);
  });

  it("rule 3: an opt-out is terminal for everyone (check_violation)", () => {
    expect(BODY).toMatch(/an SMS opt-out is terminal and its evidence is immutable'\s+using errcode = 'check_violation'/);
  });

  it("rule 4: a member's withdrawal is source practitioner, on the database clock", () => {
    expect(BODY.match(/is distinct from 'practitioner'/g)).toHaveLength(2);
    expect(BODY.match(/new\.sms_opted_out_at := now\(\);/g)).toHaveLength(2);
  });

  it("never reveals a value in an error: only the caller's role", () => {
    for (const m of BODY.matchAll(/raise exception\s+'([^']*)'/g)) {
      expect(m[1]).not.toMatch(/%.*%/);
    }
    expect(BODY).not.toMatch(/raise exception[^;]*new\.|raise exception[^;]*old\./i);
  });
});
