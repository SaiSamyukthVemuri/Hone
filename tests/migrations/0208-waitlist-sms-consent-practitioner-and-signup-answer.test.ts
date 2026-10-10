import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0208 — waitlist SMS consent: practitioner recording and the signup
// answer. SOURCE CONTRACT.
//
// Behaviour (what the commands write and refuse, the guard and the evidence
// shapes) is proved against a real database in
// tests/db/waitlist-sms-consent-practitioner-and-signup.db.test.ts. This file
// pins what that cannot see:
// - the applied migrations it carries or wraps are byte-identical;
// - the transition guard is 0203's, changed by exactly ONE inserted clause;
// - exactly three functions, revoked by name, granted to service_role only;
// - no rows written, no table privilege granted, no studio column touched.
// ===========================================================================

const VERSION = "0208";
const FILE = "0208_waitlist_sms_consent_practitioner_and_signup_answer.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read(FILE);
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");

const GUARD = "new_client_waitlist_entries_transition_guard";
const RECORD = "record_waitlist_sms_consent_by_practitioner";
const RECORD_SIG = `${RECORD}(uuid, uuid, uuid, text, text, boolean, date)`;
const SIGNUP = "join_new_client_waitlist_with_sms_answer";
const SIGNUP_SIG = `${SIGNUP}(uuid, text, text, text, boolean, boolean)`;

/** A function's full definition, from its create statement to the closing $$;. */
function definition(sql: string, fn: string): string {
  const start = sql.indexOf(`create or replace function public.${fn}(`);
  expect(start, `no ${fn} definition`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + "$$;".length);
}
const normalise = (sql: string) => stripComments(sql).replace(/\s+/g, " ").trim();

describe("0208 sits correctly in the migration sequence", () => {
  it("is no longer the repository maximum", () => {
    // HANDED OFF, per CLAUDE.md §2: only the CURRENT max may assert
    // `isRepoMax`, and that claim now lives in the current max's own test.
    // 0207 handed it to this file; WAIT-v4 PR0's 0209 took it from here.
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

describe("0208 corrects forward and leaves every applied migration untouched", () => {
  // The migrations whose objects 0208 carries (the guard, the evidence check)
  // or wraps (the guarded join), and the applied predecessor.
  const APPLIED: ReadonlyArray<readonly [string, string]> = [
    ["0202_waitlist_profile_and_sms_consent_authority.sql",
     "7a95e4e66c7c5fe50dbb2d7e73d54f7155c54f376a504ff2fbac47826dbb4ce1"],
    ["0203_waitlist_mobile_verification_authority.sql",
     "c9453ebb8d9a6c94ff1af534c4f2e9930470f2274d205ecf2ad52ecfadbe340b"],
    ["0204_new_client_admission_mode.sql",
     "186fa6cb3154c85d2987f1e75aeee6f7361004f1b535cc44a46a27f96b4db219"],
    ["0207_sms_invitation_claim_serialized.sql",
     "e85239e027623daac7b21c0541458f370c9a7ecedf78baef171575aeb4ed87b5"],
  ];
  for (const [file, sha] of APPLIED) {
    it(`${file} is byte-identical to the applied file`, () => {
      expect(createHash("sha256").update(read(file), "utf8").digest("hex")).toBe(sha);
    });
  }

  it("opens with begin + lock_timeout and closes with commit", () => {
    const statements = TOP_LEVEL.trim();
    expect(statements).toMatch(/^begin;\s*set local lock_timeout = '5s';/);
    expect(statements.endsWith("commit;")).toBe(true);
  });

  it("defines exactly three functions: the guard and the two commands", () => {
    const creates = [...CODE.matchAll(/create\s+(or\s+replace\s+)?function\s+public\.(\w+)\s*\(/gi)].map((m) => m[2]);
    expect(creates.sort()).toEqual([GUARD, RECORD, SIGNUP].sort());
  });
});

describe("the transition guard is 0203's, with exactly one clause inserted", () => {
  // `create or replace function` silently drops every rule the new body does
  // not mention. Comparing whole bodies, with ONLY the write-once consent
  // clause removed from 0208's, proves nothing was lost or altered.
  const guardLines = (sql: string): string[] =>
    stripComments(definition(sql, GUARD))
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "");

  const BEFORE = guardLines(read("0203_waitlist_mobile_verification_authority.sql"));
  const AFTER = guardLines(SQL);

  const clauseStart = AFTER.findIndex((l) => /^\s*if old\.sms_consent_at is not null\s*$/.test(l));
  const clauseEnd = AFTER.findIndex((l, i) => i > clauseStart && /^\s*end if;\s*$/.test(l));

  it("the inserted clause makes consent evidence write-once", () => {
    expect(clauseStart, "no write-once consent clause").toBeGreaterThan(-1);
    expect(clauseEnd).toBeGreaterThan(clauseStart);
    const clause = AFTER.slice(clauseStart, clauseEnd + 1).join("\n");
    expect(clause).toMatch(/consent evidence is write-once; it may be added, never changed or removed/);
    for (const col of [
      "sms_consent_at",
      "sms_consent_source",
      "sms_consent_text_version",
      "sms_consent_recorded_by_practitioner_id",
      "sms_consent_scope",
      "sms_consent_evidence_ref",
      "sms_consent_given_on",
    ]) {
      expect(clause, `the clause must freeze ${col}`).toMatch(
        new RegExp(`new\\.${col}\\s+is distinct from old\\.${col}`),
      );
    }
  });

  it("without that clause, the body is 0203's line for line", () => {
    const withoutClause = [...AFTER.slice(0, clauseStart), ...AFTER.slice(clauseEnd + 1)];
    expect(withoutClause).toEqual(BEFORE);
  });

  it("the clause sits after the terminal opt-out rule, inside the same guard", () => {
    const optOut = AFTER.findIndex((l) => /an opt-out is terminal/.test(l));
    expect(optOut).toBeGreaterThan(-1);
    expect(clauseStart).toBeGreaterThan(optOut);
  });
});

describe("the evidence shapes: no invented wording, no mixed provenance", () => {
  const CHECK = (() => {
    const m = TOP_LEVEL.match(
      /add constraint new_client_waitlist_entries_sms_consent_evidence_check\s+check\s*\(([\s\S]*?)\);/,
    );
    expect(m, "the evidence check is not re-created").not.toBeNull();
    return m![1].replace(/\s+/g, " ");
  })();

  it("a practitioner record carries no wording version and all of its provenance", () => {
    expect(CHECK).toMatch(
      /sms_consent_source = 'practitioner' and sms_consent_text_version is null and sms_consent_recorded_by_practitioner_id is not null and sms_consent_scope is not null and sms_consent_evidence_ref is not null/,
    );
  });

  it("a form consent carries its wording and none of the practitioner provenance", () => {
    expect(CHECK).toMatch(
      /sms_consent_source in \('public_form', 'prospect_link'\) and sms_consent_text_version is not null and sms_consent_recorded_by_practitioner_id is null and sms_consent_scope is null and sms_consent_evidence_ref is null and sms_consent_given_on is null/,
    );
  });

  it("adds exactly the four provenance columns, nullable and without defaults", () => {
    const added = [...TOP_LEVEL.matchAll(/add column if not exists (\w+)\s+([^,;]+)/g)].map((m) => [m[1], m[2].trim()]);
    expect(added.map(([c]) => c).sort()).toEqual(
      [
        "sms_consent_evidence_ref",
        "sms_consent_given_on",
        "sms_consent_recorded_by_practitioner_id",
        "sms_consent_scope",
      ].sort(),
    );
    for (const [col, decl] of added) {
      expect(decl, `${col} must be nullable`).not.toMatch(/not null/i);
      expect(decl, `${col} must have no default`).not.toMatch(/\bdefault\b/i);
    }
  });

  it("the recorder is a SAME-STUDIO actor FK, never a simple FK to practitioners (0179)", () => {
    expect(TOP_LEVEL.replace(/\s+/g, " ")).toMatch(
      /add constraint new_client_waitlist_entries_sms_consent_recorder_same_studio_fk foreign key \(sms_consent_recorded_by_practitioner_id, studio_id\) references public\.practitioners \(id, studio_id\) on delete restrict;/,
    );
    // A simple FK would join tests/db/actor-fk-integrity's pinned nine.
    expect(TOP_LEVEL).not.toMatch(/references public\.practitioners\s*\(\s*id\s*\)/);
  });

  it("the source and wording vocabularies of 0202 are not widened", () => {
    expect(TOP_LEVEL).not.toMatch(/sms_consent_source_check/);
    expect(TOP_LEVEL).not.toMatch(/sms_consent_text_version_check/);
  });
});

describe("the practitioner command", () => {
  const BODY = normalise(definition(SQL, RECORD));

  it("derives the actor from the session user, an ACTIVE practitioner of THIS studio, and requires owner", () => {
    expect(BODY).toMatch(/where p\.studio_id = p_studio_id and p\.user_id = p_actor_user_id and p\.active = true/);
    expect(BODY).toMatch(/if v_role <> 'owner' then return 'not_owner';/);
  });

  it("refuses STOP before anything else about the row, then existing evidence, then a missing number", () => {
    const stop = BODY.indexOf("return 'opted_out'");
    const existing = BODY.indexOf("return 'already_consented'");
    const noPhone = BODY.indexOf("return 'no_phone'");
    expect(stop).toBeGreaterThan(-1);
    expect(existing).toBeGreaterThan(stop);
    expect(noPhone).toBeGreaterThan(existing);
  });

  it("writes source practitioner with NO wording version, from the database clock", () => {
    expect(BODY).toMatch(/sms_consent_source = 'practitioner'/);
    expect(BODY).toMatch(/sms_consent_text_version = null/);
    expect(BODY).toMatch(/sms_consent_at = clock_timestamp\(\)/);
    expect(BODY).not.toMatch(/\bnow\(\)/);
  });

  it("never writes the phone or the verification", () => {
    expect(BODY).not.toMatch(/\bset\b[^;]*\bphone\s*=/);
    expect(BODY).not.toMatch(/mobile_verified_at\s*=/);
  });
});

describe("the signup command", () => {
  const BODY = normalise(definition(SQL, SIGNUP));

  it("refuses a missing answer before it does anything else", () => {
    const missing = BODY.indexOf("if p_sms_consent is null then");
    const join = BODY.indexOf("join_new_client_waitlist_guarded(");
    expect(missing).toBeGreaterThan(-1);
    expect(join).toBeGreaterThan(missing);
  });

  it("wraps the unchanged guarded join instead of copying it", () => {
    expect(BODY).toMatch(
      /from public\.join_new_client_waitlist_guarded\( p_studio_id, p_name, p_email, p_phone, p_legacy_bridge_waitlist\) j;/,
    );
    expect(BODY).not.toMatch(/insert into/);
  });

  it("records a Yes on a NEW entry only, with the public sentence", () => {
    expect(BODY).toMatch(/if v_result = 'created' and p_sms_consent then/);
    expect(BODY).toMatch(/sms_consent_source = 'public_form'/);
    expect(BODY).toMatch(/sms_consent_text_version = 'waitlist_sms_operational_v1'/);
    expect(BODY).toMatch(/and e\.sms_consent_at is null/);
  });
});

describe("privileges and blast radius", () => {
  it("revokes every grantee BY NAME, then grants the two commands to service_role only", () => {
    for (const sig of [RECORD_SIG, SIGNUP_SIG, `${GUARD}()`]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        const escaped = sig.replace(/[()]/g, "\\$&");
        expect(TOP_LEVEL, `${sig} not revoked from ${role}`).toMatch(
          new RegExp(`revoke execute on function public\\.${escaped} from ${role};`),
        );
      }
    }
    const grants = [...TOP_LEVEL.matchAll(/grant\s+[^;]+;/gi)].map((m) => m[0].replace(/\s+/g, " "));
    expect(grants.sort()).toEqual(
      [
        `grant execute on function public.${RECORD_SIG} to service_role;`,
        `grant execute on function public.${SIGNUP_SIG} to service_role;`,
      ].sort(),
    );
  });

  it("writes no rows at top level and touches no studio column or switch", () => {
    expect(TOP_LEVEL).not.toMatch(/\b(insert\s+into|update\s+public|delete\s+from|truncate)\b/i);
    expect(CODE).not.toMatch(/alter table public\.studios/i);
    expect(CODE).not.toMatch(/update public\.studios/i);
    expect(CODE).not.toMatch(/send_[a-z0-9_]*sms/);
  });
});
