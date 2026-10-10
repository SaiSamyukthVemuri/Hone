import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0210 — SMS-04: the required-phone signup (wording v2) and the
// waitlist join acknowledgement text. SOURCE CONTRACT.
//
// Behaviour is proved against a real database in
// tests/db/sms-waitlist-join-ack.db.test.ts. This file pins what that cannot
// see:
// - every applied migration it replaces a piece of, wraps or relies on is
//   byte-identical, and 0208's signup command is NOT redefined;
// - the identity guard is 0206's with exactly ONE clause added;
// - exactly three function definitions, revoked by name, granted to
//   service_role only;
// - no rows written at top level, no table privilege granted, no switch set.
// ===========================================================================

const VERSION = "0210";
const FILE = "0210_sms_waitlist_join_acknowledgement.sql";
const MIGRATIONS = path.join(process.cwd(), "supabase/migrations");
const read = (f: string) => readFileSync(path.join(MIGRATIONS, f), "utf8");
const SQL = read(FILE);
// LINE comments first: a comment must never satisfy a code assertion.
const stripComments = (sql: string) => sql.replace(/^\s*--.*$/gm, " ").replace(/\s+--.*$/gm, " ");
const CODE = stripComments(SQL);
// Everything OUTSIDE dollar-quoted bodies: the migration's own top-level statements.
const TOP_LEVEL = CODE.replace(/\$\$[\s\S]*?\$\$/g, " ");
const normalise = (sql: string) => stripComments(sql).replace(/\s+/g, " ").trim();

const CLAIM = "claim_waitlist_join_ack_sms";
const SIGNUP = "join_new_client_waitlist_with_phone_and_sms_answer";
const SIGNUP_SIG = `${SIGNUP}(uuid, text, text, text, boolean, boolean)`;
const GUARD = "sms_outbound_messages_identity_guard";

/** A function's full definition, from its create statement to the closing $$;. */
function definition(sql: string, fn: string): string {
  const start = sql.indexOf(`create or replace function public.${fn}(`);
  expect(start, `no ${fn} definition`).toBeGreaterThan(-1);
  const end = sql.indexOf("$$;", start);
  return sql.slice(start, end + "$$;".length);
}

describe("0210 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. 0208 handed the claim over when this file was authored.
    // (0209 is reserved by WAIT #820; this branch merges after it, and that
    // merge hands 0209's claim over here in turn.)
    expect(isRepoMax(VERSION), "0210 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0210").toEqual([]);
  });

  it("is allocated exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });
});

describe("0210 corrects forward and leaves every applied migration untouched", () => {
  // The migrations whose objects 0210 replaces whole (0202's version check,
  // 0206's ledger checks and identity guard), wraps (0204's guarded join),
  // calls (0199's sms_normalized_phone) or must leave alone (0207's claim,
  // 0208's signup command).
  const APPLIED: ReadonlyArray<readonly [string, string]> = [
    ["0199_reminder_sms_candidate_selection.sql",
     "9561024b06311526ea04e91b81a006abd8dd92c89296cb761887e34a6d04fca5"],
    ["0202_waitlist_profile_and_sms_consent_authority.sql",
     "7a95e4e66c7c5fe50dbb2d7e73d54f7155c54f376a504ff2fbac47826dbb4ce1"],
    ["0204_new_client_admission_mode.sql",
     "186fa6cb3154c85d2987f1e75aeee6f7361004f1b535cc44a46a27f96b4db219"],
    ["0206_sms_delivery_foundation.sql",
     "e3cdaf222f39fc34fe04f7bf93cdbbef62f0b08c2b1033fd9c44010cda86b0ab"],
    ["0207_sms_invitation_claim_serialized.sql",
     "e85239e027623daac7b21c0541458f370c9a7ecedf78baef171575aeb4ed87b5"],
    ["0208_waitlist_sms_consent_practitioner_and_signup_answer.sql",
     "1c6c512b6f59fc7cde5cc61f538b8acac4a526d9131df7c3e4a4b35d324637f0"],
  ];
  for (const [file, sha] of APPLIED) {
    it(`${file} is byte-identical to the applied file`, () => {
      expect(createHash("sha256").update(read(file), "utf8").digest("hex")).toBe(sha);
    });
  }

  it("opens with begin + lock_timeout and closes with commit", () => {
    expect(TOP_LEVEL.trim()).toMatch(/^begin;\s+set local lock_timeout = '5s';/);
    expect(TOP_LEVEL.trim()).toMatch(/commit;$/);
  });

  it("defines exactly three functions: the identity guard, the claim and the signup", () => {
    const defined = [...CODE.matchAll(/create or replace function public\.(\w+)\(/g)].map((m) => m[1]);
    expect(defined.sort()).toEqual([CLAIM, SIGNUP, GUARD].sort());
  });

  it("leaves 0208's signup command exactly as it is: not redefined, not dropped, not re-granted", () => {
    // Statements only: the new command's COMMENT may name the one it supersedes.
    expect(CODE).not.toMatch(
      /^\s*(create or replace function|drop function|grant|revoke)\b[^;]*join_new_client_waitlist_with_sms_answer/im,
    );
    expect(TOP_LEVEL).not.toMatch(/^\s*drop\s+function\b/im);
  });
});

describe("the ledger's fifth purpose", () => {
  it("adds one nullable subject column, tied to its studio by a composite key", () => {
    expect(TOP_LEVEL).toMatch(/alter table public\.sms_outbound_messages\s+add column waitlist_entry_id uuid;/);
    expect(normalise(SQL)).toContain(
      "foreign key (waitlist_entry_id, studio_id) references public.new_client_waitlist_entries (id, studio_id) on delete cascade",
    );
  });

  it("the purpose check is 0206's four plus waitlist_join_acknowledgement, and nothing else", () => {
    const m = normalise(SQL).match(/add constraint sms_outbound_messages_purpose_ck check \(purpose in \(([^)]*)\)\)/);
    expect(m).not.toBeNull();
    expect(m![1].split(",").map((v) => v.trim().replace(/'/g, "")).sort()).toEqual(
      [
        "appointment_confirmation",
        "appointment_reminder_24h",
        "appointment_reminder_2h",
        "waitlist_invitation",
        "waitlist_join_acknowledgement",
      ].sort(),
    );
  });

  it("the subject check names exactly one subject per purpose, the entry only for the join text", () => {
    const n = normalise(SQL);
    expect(n).toContain(
      "when purpose = 'waitlist_join_acknowledgement' then waitlist_entry_id is not null and appointment_id is null and waitlist_invitation_id is null",
    );
    expect(n).toContain(
      "when purpose = 'waitlist_invitation' then waitlist_invitation_id is not null and appointment_id is null and waitlist_entry_id is null",
    );
    expect(n).toContain(
      "else appointment_id is not null and waitlist_invitation_id is null and waitlist_entry_id is null",
    );
  });

  it("at most one join text per entry is an index, not a code path", () => {
    expect(normalise(SQL)).toContain(
      "create unique index sms_outbound_messages_one_join_ack_per_entry on public.sms_outbound_messages (waitlist_entry_id) where waitlist_entry_id is not null",
    );
  });

  it("the identity guard is 0206's, with exactly one clause added for the new subject", () => {
    const lines = (sql: string) =>
      definition(sql, GUARD)
        .split("\n")
        .map((l) => l.replace(/--.*$/, "").trim())
        .filter(Boolean);
    const before = lines(read("0206_sms_delivery_foundation.sql"));
    const after = lines(SQL);
    const added = after.filter((l) => !before.includes(l));
    expect(added).toEqual(["or new.waitlist_entry_id is distinct from old.waitlist_entry_id"]);
    expect(before.filter((l) => !after.includes(l))).toEqual([]);
  });
});

describe("the claim: only a fresh public-form signup with its own v2 Yes", () => {
  const body = normalise(definition(SQL, CLAIM));

  it("holds the entry row while it decides", () => {
    expect(body).toMatch(/from public\.new_client_waitlist_entries e where e\.id = p_entry_id and e\.studio_id = p_studio_id for no key update/);
  });

  it("asks the studio switch the invitation text uses, and writes nothing when it is off", () => {
    expect(body).toContain("select s.send_waitlist_invitation_sms into v_enabled");
    expect(body).toMatch(/if v_enabled is distinct from true then return query select 'studio_disabled'/);
  });

  it("admits only a waiting public-form entry whose consent is the form's own v2 Yes, inside the join's minute", () => {
    for (const clause of [
      "v_entry.status is distinct from 'waiting'",
      "v_entry.source is distinct from 'public_booking'",
      "v_entry.joined_at_provenance is distinct from 'form'",
      "v_entry.sms_consent_at is null",
      "v_entry.sms_consent_source is distinct from 'public_form'",
      "v_entry.sms_consent_text_version is distinct from 'waitlist_sms_operational_v2'",
      "v_entry.sms_consent_at < v_entry.joined_at",
      "v_entry.sms_consent_at > v_entry.joined_at + interval '1 minute'",
    ]) {
      expect(body, clause).toContain(clause);
    }
  });

  it("refuses an entry that is no longer new (15 minutes), and a second claim for one entry", () => {
    expect(body).toContain("v_entry.joined_at < clock_timestamp() - interval '15 minutes'");
    expect(body).toMatch(/select 1 from public\.sms_outbound_messages m where m\.waitlist_entry_id = p_entry_id/);
    expect(body).toContain("on conflict (waitlist_entry_id) where waitlist_entry_id is not null do nothing");
  });

  it("allows one join text per sendable number per 24 hours, across studios, counting only attempts that may have arrived", () => {
    expect(body).toContain("v_number := public.sms_normalized_phone(v_entry.phone)");
    expect(body).toContain("m.claimed_at > clock_timestamp() - interval '24 hours'");
    expect(body).toContain("m.status not in ('skipped', 'refused')");
    expect(body).toContain("public.sms_normalized_phone(o.phone) = v_number");
    // ACROSS studios: no studio filter on the earlier attempts.
    expect(body).not.toMatch(/m\.studio_id = p_studio_id/);
  });

  it("writes exactly one ledger row, of its own purpose, and only when it claims", () => {
    expect((body.match(/insert into public\.sms_outbound_messages/g) ?? []).length).toBe(1);
    expect(body).toContain(
      "insert into public.sms_outbound_messages (studio_id, purpose, waitlist_entry_id) values (p_studio_id, 'waitlist_join_acknowledgement', p_entry_id)",
    );
    expect(body).not.toMatch(/\bupdate public\.|\bdelete from\b/);
  });
});

describe("the signup: a required phone, the guarded join unchanged, a Yes as v2", () => {
  const body = normalise(definition(SQL, SIGNUP));

  it("refuses a missing answer, then a missing or unsendable phone, before anything else", () => {
    const answer = body.indexOf("if p_sms_consent is null then");
    const phone = body.indexOf("if public.sms_normalized_phone(p_phone) is null then");
    const join = body.indexOf("join_new_client_waitlist_guarded(");
    expect(answer).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(answer);
    expect(join).toBeGreaterThan(phone);
  });

  it("wraps 0204's guarded join instead of copying it", () => {
    expect(body).toContain(
      "from public.join_new_client_waitlist_guarded( p_studio_id, p_name, p_email, p_phone, p_legacy_bridge_waitlist) j",
    );
    expect(body).not.toMatch(/insert into public\.new_client_waitlist_entries/);
  });

  it("records a Yes only on the entry it created, as v2, from the database clock", () => {
    expect(body).toContain("if v_result = 'created' and p_sms_consent then");
    expect(body).toContain("sms_consent_at = clock_timestamp()");
    expect(body).toContain("sms_consent_source = 'public_form'");
    expect(body).toContain("sms_consent_text_version = 'waitlist_sms_operational_v2'");
    expect(body).not.toContain("waitlist_sms_operational_v1");
  });

  it("the stored wording version admits exactly v1 and v2", () => {
    expect(normalise(SQL)).toContain(
      "check (sms_consent_text_version is null or sms_consent_text_version in ('waitlist_sms_operational_v1', 'waitlist_sms_operational_v2'))",
    );
  });
});

describe("privileges and blast radius", () => {
  it("revokes every grantee BY NAME, then grants the two commands to service_role only", () => {
    for (const sig of [`${CLAIM}(uuid, uuid)`, SIGNUP_SIG]) {
      for (const role of ["public", "anon", "authenticated", "service_role"]) {
        expect(TOP_LEVEL, `${sig} from ${role}`).toContain(`revoke execute on function public.${sig} from ${role};`);
      }
      expect(TOP_LEVEL).toContain(`grant execute on function public.${sig} to service_role;`);
    }
    // Statements only (a line that starts with grant): comment text may say "grant".
    const grants = [...TOP_LEVEL.matchAll(/^\s*grant\b[^;]*;/gim)].map((m) => m[0].trim());
    expect(grants).toHaveLength(2);
    for (const g of grants) expect(g).toMatch(/to service_role;$/);
  });

  it("writes no rows at top level and sets no studio switch", () => {
    expect(TOP_LEVEL).not.toMatch(/\binsert\s+into\b/i);
    expect(TOP_LEVEL).not.toMatch(/\bupdate\s+public\./i);
    expect(TOP_LEVEL).not.toMatch(/\bdelete\s+from\b/i);
    expect(CODE).not.toMatch(/send_waitlist_invitation_sms\s*=/);
  });
});
