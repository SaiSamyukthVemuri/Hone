import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { countVersion, isRepoMax, versionsAbove } from "./helpers/migration-state";

// ===========================================================================
// Migration 0205 — a NEW studio is born with its admission authority already
// initialized.
//
// THE REGRESSION THIS CLOSES. 0204 gave `new_client_admission_mode` a correct
// `not null default 'open'` but left `new_client_admission_mode_set_at` with no
// default, while simultaneously reading `set_at IS NULL` as the authoritative
// marker for an UNSTAMPED PRE-0204 LEGACY row. A studio created after 0204 was
// therefore born `open` / NULL — indistinguishable from a legacy row — and its
// brand-new owner was told `legacy_waitlist_cutover_required` on selecting Open
// or Closed.
//
// WHAT THIS FILE PROVES, AND WHAT IT DELIBERATELY DOES NOT.
//
// This is the SOURCE CONTRACT: it reads the migration text and asserts the
// shape of the change — one default, two comments, and TWO `update
// public.studios` statements per candidate: the guard PROBE (unpermitted,
// executed to be refused, rolled back on every path) and the bounded REPAIR
// (permitted, the one that writes). No other DML, and no logic edit. It cannot
// prove behaviour, because SQL text is not a running database.
//
// THIS HEADER HAS BEEN WRONG TWICE, both times by understating the writes. It
// first said "no DML", true until the window repair was added. It then said
// "ONE BOUNDED update", true until the guard probe became a second executable
// statement. The claim is a BOUND on two statements of different kinds now, and
// the assertions below enforce it as one. The
// behavioural claims (a fresh insert is stamped, a fresh owner may choose any
// mode immediately, a legacy row still cannot) are proved against a real
// database in tests/db/new-studio-admission-default.db.test.ts, and the
// resolution claim in tests/lib/booking/new-client-admission.test.ts.
//
// The division matters: an earlier instinct was to assert the behaviour here by
// grepping for the words. A grep that "proves" an INSERT is stamped is a grep
// that stays green when the default is removed from a column it never read.
// ===========================================================================

const VERSION = "0205";
const FILE = "0205_new_studio_admission_default.sql";
const SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations", FILE),
  "utf8",
);

/** The file with every `--` comment line removed, so prose cannot satisfy a claim. */
const CODE = SQL.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

// CODE strips LINE comments only, and that is a hole unless block comments are
// absent: independent verification wrapped this migration's entire fix in
// `/* */`, substituted a different ALTER, and every source assertion still
// passed because the real statements had become invisible prose.
//
// The fix is NOT a smarter stripper. A correct one needs nesting and
// string-awareness - PostgreSQL nests `/* */` - and four attempts at exactly
// that kind of parser were defeated on this branch. So the migration is simply
// required to use `--` only.
//
// WHAT THAT BUYS, AND WHAT IT DOES NOT. An earlier revision of this comment
// claimed it makes the stripper "sound by construction". That is FALSE, and
// independent verification defeated all 23 assertions in this file with ZERO
// block comments present, by two routes this guard cannot touch:
//
//   * STRING LITERALS. `CODE` keeps them verbatim, so moving the greppable text
//     into one satisfies the positive assertions while the real statement does
//     the opposite - a `raise notice '... set default now()'` alongside an
//     actual `drop default` passed every check here.
//   * DYNAMIC SQL. `execute 'dele' || 'te from public.studios ...'` defeats
//     every negative assertion, because no banned verb appears in the source.
//
// So this guard closes ONE hole - a `/* */` region hiding executable SQL from a
// `--`-only stripper - and nothing more. What actually bounds the two above is
// the DB lane: it applies the migration and asserts behaviour, and it reds 6
// tests against the inverted-default variant. This file is a source contract,
// not a proof that the SQL does what it says; treat a green run here as
// necessary and never sufficient.
it("keeps every `--` comment on its OWN LINE, so stripping them cannot fuse keywords", () => {
  // Review's third narrowing of the same guarantee. `COMMENT -- sep` on one
  // line followed by `ON TABLE … IS '…'` on the next is VALID PostgreSQL - the
  // line comment separates the keywords - but a stripper that removes only
  // whole `--` lines leaves `COMMENT -- sep` behind, so a matcher looking for
  // whitespace between COMMENT and ON never sees the statement.
  //
  // Patching that matcher a third time is the wrong move: recognising statement
  // boundaries through arbitrary comment placement is lexing, which is the
  // instrument this branch has had defeated four times and been told to stop
  // using. So make the evasion IMPOSSIBLE instead. With `--` confined to whole
  // lines and `/* */` banned outright (next test), no comment can sit between
  // two keywords, and stripping whole `--` lines therefore leaves real
  // whitespace wherever a comment used to be.
  //
  // This is what the applied-statement COMMENT count in the DB suite rests on.
  // The guard lives on the FILE and the count reads the APPLIED text, so the
  // composition only holds while this passes - which is why it fails loudly
  // rather than being documented as an assumption.
  const inlineComment = SQL.split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => line.includes("--") && !line.trimStart().startsWith("--"));
  expect(
    inlineComment.map(({ n, line }) => `${n}: ${line.trim()}`),
    "0205 must keep `--` comments on their own line: an inline one can separate two SQL keywords, which defeats every whitespace-based matcher over this file and over the applied statements",
  ).toEqual([]);
});

it("uses LINE comments only, so the CODE stripper above cannot be outrun", () => {
  expect(
    SQL,
    "0205 must not use block comments: CODE strips only `--`, so a `/* */` region would hide executable SQL from every assertion in this file",
  ).not.toMatch(/\/\*/);
});

/**
 * The apply-time repair block, as CODE.
 *
 * Extracted from the RAW file, because the markers are themselves `--` comment
 * lines and `CODE` has already stripped them — reading the block out of `CODE`
 * finds nothing. The extracted text is then comment-stripped on its own, so a
 * claim below cannot be satisfied by the block's prose.
 */
const REPAIR_BLOCK = (() => {
  const m = /-- >>> 0205 APPLY-TIME REPAIR BEGIN\n([\s\S]*?)-- <<< 0205 APPLY-TIME REPAIR END/.exec(
    SQL,
  );
  if (!m) return null;
  return m[1]
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
})();

describe("0205 sits correctly in the migration sequence", () => {
  it("is no longer the repository maximum", () => {
    // HANDED OFF, per CLAUDE.md §2: only the CURRENT max may assert
    // `isRepoMax`, and that claim now lives in the current max's own test.
    // Keeping it here is precisely the "trip on the next one" pin §2 forbids.
    expect(isRepoMax(VERSION)).toBe(false);
    // DERIVED, NOT PINNED. Two facts about an older migration hold forever and
    // for every future head: something sits above it, and everything above it
    // is greater. A literal list of what sits above would be the same
    // forbidden pin wearing different clothes.
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

  it("opens its own transaction with a lock timeout", () => {
    // `supabase db push` does NOT wrap a file in a transaction, so a bare
    // `SET LOCAL` emits 25P01 and never arms. See CLAUDE.md §5.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/set local lock_timeout = '5s';/);
    expect(CODE.indexOf("begin;")).toBeLessThan(CODE.indexOf("set local lock_timeout"));
  });
});

describe("the fix is ONE default on the column that was missing one", () => {
  it("sets a default on new_client_admission_mode_set_at", () => {
    expect(CODE).toMatch(
      /alter table public\.studios\s+alter column new_client_admission_mode_set_at set default now\(\)/,
    );
  });

  it("uses now(), the same default public.studios.created_at already carries", () => {
    // So a studio's creation instant and its admission-initialization instant
    // are ONE transaction timestamp rather than two that merely look alike.
    expect(CODE).toMatch(/set default now\(\)/);
    expect(CODE, "a literal or a non-database clock would drift from created_at").not.toMatch(
      /set default '[^']*'::timestamptz/,
    );
  });

  it("does NOT restate the two defaults that are already correct", () => {
    // `mode` already defaults 'open' from 0204 and `set_by` already has none.
    // Re-asserting them would add statements to a production apply for no
    // behavioural change. The full three-column shape is asserted by the DB
    // test instead, which is where it is actually observable.
    expect(CODE).not.toMatch(/alter column new_client_admission_mode set default/);
    expect(CODE).not.toMatch(/alter column new_client_admission_mode_set_by set default/);
  });
});

describe("the DEFAULT cannot backfill, which is why the repair is explicit", () => {
  it("uses ALTER COLUMN SET DEFAULT, which never rewrites an existing row", () => {
    // The distinction is load-bearing. `ADD COLUMN ... DEFAULT` populates
    // existing rows in PostgreSQL 11+; `ALTER COLUMN ... SET DEFAULT` records a
    // default for FUTURE inserts only.
    //
    // SCOPED TO THE DEFAULT, deliberately. It is census members and other
    // pre-0204 legacy rows that keep `set_at` NULL - not "every pre-fix studio",
    // which this comment used to say and which is false for a row created
    // between the census and this apply: section 3 stamps that one on purpose.
    expect(CODE).toMatch(/alter column new_client_admission_mode_set_at set default/);
    expect(CODE).not.toMatch(/add column[^;]*new_client_admission_mode_set_at/);
  });

  it("its data manipulation is TWO updates: the refused probe and the bounded repair", () => {
    // THE CENSUS WAS A POINT IN TIME. It found nothing to repair, but 0204 is
    // applied while 0205 is not, so a studio created in the window BETWEEN the
    // census and this apply is born open/NULL and the default cannot reach it —
    // `SET DEFAULT` only governs inserts that come after it. Section 3 repairs
    // that window, so the earlier "zero DML" claim is retired.
    //
    // The bound still has to be asserted, and this is it.
    //
    // TWO updates now, and they are different in kind. The behavioural guard
    // probe attempts an admission write it EXPECTS to be refused, and the repair
    // performs the real one. Both are against `studios` and nothing else.
    const updates = [...CODE.matchAll(/\bupdate\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(updates, "0205 writes only `studios`, and twice: probe then repair").toEqual([
      "studios",
      "studios",
    ]);
    for (const verb of [/\binsert\s+into\b/i, /\bdelete\s+from\b/i, /\btruncate\b/i]) {
      expect(CODE, `0205 may only UPDATE; found ${verb}`).not.toMatch(verb);
    }

    // THE PROBE'S WRITE CANNOT PERSIST, and that is what makes the second UPDATE
    // acceptable in a migration whose blast radius is documented. It sits in a
    // plpgsql block with an EXCEPTION handler - a subtransaction - and BOTH exits
    // are exceptions: the guard's `check_violation`, or the sentinel raise when
    // nothing refused it. Catching either rolls the attempt back.
    const probe = /begin\s*\n\s*update public\.studios s\n([\s\S]*?)\n    end;/.exec(CODE);
    expect(probe, "the guard probe block could not be located").toBeTruthy();
    expect(probe![1]).toMatch(/raise exception 'HONE_0205_GUARD_NOT_POLICING'/);
    expect(probe![1]).toMatch(/exception\s*\n\s*when check_violation then/);
    expect(
      probe![1],
      "an unexpected error must propagate, not be swallowed by a probe",
    ).toMatch(/else\s*\n\s*(--[^\n]*\n\s*)*raise;/);
  });

  it("eligibility is CENSUS MEMBERSHIP by id, never a timestamp", () => {
    // `studios.created_at` is MUTABLE by the row's own owner — RLS policy
    // "studios: owners update" plus column UPDATE privilege on created_at, and
    // the admission guard covers only the three admission fields. A timestamp
    // boundary could therefore be defeated by FORWARD-dating a genuine legacy
    // studio past it, which would stamp it and silently drop its cutover. A row
    // cannot rewrite its own id, so identity is the id.
    const block = REPAIR_BLOCK!;
    expect(block, "the census set must be declared as uuids").toMatch(
      /k_census constant uuid\[\] := array\[/,
    );
    // Seven ids, because the census enumerated seven studios. COUNTED INSIDE THE
    // ARRAY LITERAL, not across the block: the guard probe carries sentinel uuids
    // of its own, and a block-wide count silently became 10 the moment it landed.
    const arr = /k_census constant uuid\[\] := array\[([\s\S]*?)\];/.exec(block);
    expect(arr, "the census array literal could not be located").toBeTruthy();
    const ids = [...arr![1].matchAll(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'::uuid/g)];
    expect(ids.length, "the census is seven studios").toBe(7);
    // Selection and both fail-closed queries must all exclude census members.
    expect(
      [...block.matchAll(/not \(s\.id = any \(k_census\)\)/g)].length,
      "every query over candidates must exclude the census set",
    ).toBe(3);
  });

  it("created_at carries NO part of the eligibility decision", () => {
    // It survives for exactly one purpose: the VALUE written into set_at, so the
    // stamp records "initialized when the studio was created". A mutable column
    // may decide a stamp's value — visible and correctable — but never a verdict.
    const block = REPAIR_BLOCK!;
    expect(block, "created_at must not appear in a predicate").not.toMatch(
      /created_at\s*(>|>=|<|<=)/,
    );
    expect(block, "and must still be the written value").toMatch(
      /new_client_admission_mode_set_at = r\.created_at/,
    );
    expect(CODE, "the retired timestamp boundary must be gone").not.toMatch(/k_boundary/);
  });

  it("it repairs ONLY unstamped system-default rows, so owner choices survive", () => {
    expect(REPAIR_BLOCK, "the repair block markers are gone").toBeTruthy();
    const block = REPAIR_BLOCK!;
    // The selection predicate must carry all three narrowing conditions.
    expect(block).toMatch(/new_client_admission_mode_set_at is null/);
    expect(block).toMatch(/new_client_admission_mode_set_by is null/);
    expect(block).toMatch(/new_client_admission_mode = 'open'/);
    // And it must write set_at from the ROW's creation instant, not the apply.
    expect(block).toMatch(/new_client_admission_mode_set_at = r\.created_at/);
    expect(block, "backfilling now() would date initialization to the apply").not.toMatch(
      /new_client_admission_mode_set_at = now\(\)/,
    );
  });

  it("arms the permit PER ROW, and clears it, rather than bypassing the guard", () => {
    // `studios_admission_mode_guard` compares the permit against the row being
    // written, so one permit cannot authorise many rows — a set-based UPDATE
    // could not pass it. The loop is therefore the guard working, not a way
    // around it, and there is no value of the permit meaning "allow anything".
    expect(CODE).toMatch(/perform set_config\(\s*'hone\.admission_mode_studio_id',\s*r\.id::text,\s*true\s*\)/);
    expect(CODE, "the permit must be released, not left armed").toMatch(
      /perform set_config\('hone\.admission_mode_studio_id',\s*'',\s*true\)/,
    );
    expect(CODE, "the repair must not disable the guard").not.toMatch(
      /alter table[^;]*disable trigger|drop trigger/i,
    );
  });

  it("proves the guard BEHAVIOURALLY, and asks pg_trigger only for diagnostics", () => {
    // FIVE CATALOG CHECKS WERE NARROWED BY REVIEW BEFORE THIS REPLACED THEM:
    // existence, enabled mode, session role, function identity, event/timing -
    // and then `tgattr` and `tgqual`, which carry the right tgfoid, the right
    // tgtype bits and an enabled mode while still never firing for these
    // columns. Enumerating ways a trigger can fail to fire was not converging,
    // so the question is asked of the database instead of its catalog.
    const block = REPAIR_BLOCK!;

    // The probe: the REPAIR'S OWN unpermitted write, which must be refused.
    expect(block).toMatch(/v_guard_policed\s*:=\s*false;/);
    expect(block).toMatch(/raise exception 'HONE_0205_GUARD_NOT_POLICING'/);
    expect(block).toMatch(/when check_violation then\n\s*v_guard_policed := true;/);
    expect(block).toMatch(/if not v_guard_policed then/);

    // PER-CANDIDATE, AND THE SAME MUTATION. A single pre-loop probe that changed
    // `set_by` on one row proved only that SOME admission write on SOME row was
    // refused: a guard with `WHEN (new.set_by IS DISTINCT FROM old.set_by)`
    // refuses exactly that and never fires for a `set_at` change, so the repair
    // ran unguarded. Measured — set_by refused (23514), set_at not refused. The
    // probe must therefore be the repair's own column, value and row.
    const probeBlock = /begin\s*\n\s*update public\.studios s[\s\S]*?\n    end;/.exec(block)![0];
    expect(probeBlock, "the probe must write the column the repair writes").toMatch(
      /set new_client_admission_mode_set_at = r\.created_at/,
    );
    expect(probeBlock, "and target the row the repair is about to write").toMatch(
      /where s\.id = r\.id/,
    );

    // It must NOT arm the permit - that is the whole point of the attempt.
    expect(
      probeBlock,
      "arming the permit would make the probe prove nothing",
    ).not.toMatch(/set_config\('hone\.admission_mode_studio_id'/);

    // And it must come BEFORE the permitted write, not after it.
    expect(
      block.indexOf("raise exception 'HONE_0205_GUARD_NOT_POLICING'"),
      "the probe must precede the permitted write",
    ).toBeLessThan(block.indexOf("perform set_config('hone.admission_mode_studio_id'"));

    // THE CATALOG IS NOW DIAGNOSTIC ONLY. pg_trigger may be read to tell an
    // operator WHY the probe failed; it may not be the gate. So any read of it
    // must sit inside the failure branch, after the behavioural decision.
    const triggerReads = [...block.matchAll(/pg_trigger/g)].map((m) => m.index!);
    expect(triggerReads.length, "pg_trigger is still read, for diagnostics").toBeGreaterThan(0);
    for (const at of triggerReads) {
      expect(
        at,
        "pg_trigger must only be read AFTER the behavioural verdict, as diagnostics",
      ).toBeGreaterThan(block.indexOf("if not v_guard_policed then"));
    }

    // And the retired catalog gates must not creep back as preconditions.
    expect(block, "tgenabled must no longer gate the repair").not.toMatch(/v_guard_mode/);
    expect(block, "tgfoid must no longer gate the repair").not.toMatch(/v_guard_fn/);
    expect(block, "tgtype must no longer gate the repair").not.toMatch(/v_guard_type/);
  });

  it("gates on CENSUS LINEAGE before any DML, and aborts rather than guessing", () => {
    // `k_census` distinguishes production's known rows only on a database
    // descended from the census that produced it. On any other non-empty
    // database — staging, a restored backup — none of those ids exist and every
    // ordinary open/unstamped row would read as post-0204 and be stamped. The
    // shape check cannot catch it: those rows ARE the expected shape.
    const block = REPAIR_BLOCK!;

    // EMPTY is allowed through: nothing to repair, no lineage to assert.
    expect(block).toMatch(/select count\(\*\) into v_studios from public\.studios/);
    expect(block).toMatch(/if v_studios = 0 then/);

    // NON-EMPTY requires EVERY census id, compared against the array's own
    // length rather than a literal 7 — a hard-coded count would drift from the
    // list it is meant to describe.
    expect(block).toMatch(/v_census_seen <> array_length\(k_census, 1\)/);
    expect(block, "the gate must ABORT, not skip").toMatch(
      /raise exception[\s\S]*?census lineage/i,
    );

    // AND IT MUST PRECEDE THE WRITE. A gate after the loop protects nothing.
    const gateAt = block.indexOf("v_census_seen <> array_length");
    const updateAt = block.indexOf("update public.studios");
    expect(gateAt).toBeGreaterThan(-1);
    expect(updateAt).toBeGreaterThan(-1);
    expect(gateAt, "the lineage gate must run BEFORE any DML").toBeLessThan(updateAt);
  });

  it("FAILS CLOSED three ways: guard present, model intact, post-condition met", () => {
    const block = REPAIR_BLOCK!;
    // 1. the guard must exist before anything is written
    expect(block).toMatch(/studios_admission_mode_guard/);
    expect(block).toMatch(/pg_trigger/);
    // 2. a NON-CENSUS unstamped row that is not a plain system default means
    //    the model is wrong, and the repair refuses rather than guessing
    expect(block).toMatch(/v_anomalous/);
    // 3. nothing in scope may still be NULL afterwards
    expect(block).toMatch(/v_left/);
    // ATTRIBUTED, not counted. Independent verification demoted this limb from
    // `raise exception` to `raise notice` and the whole DB suite still passed
    // 42/42 while this file stayed green at 23/23 - because the only checks
    // were `/v_left/` (satisfied by a notice) and a COUNT of `raise exception`
    // that the other three limbs already met. A count cannot attribute a raise
    // to the limb that needs it. So read the post-condition's own branch and
    // require the abort inside it.
    const postCondition = /if\s+v_left\s*<>\s*0\s+then([\s\S]*?)end if;/.exec(block);
    expect(postCondition, "the v_left post-condition has no if-branch").toBeTruthy();
    expect(
      postCondition![1],
      "FAIL CLOSED #4 must ABORT, not merely notice: a raise-exception count elsewhere in the block does not cover this limb",
    ).toMatch(/raise exception/);
    // All three must ABORT, which inside begin/commit rolls the whole apply back.
    expect([...block.matchAll(/raise exception/g)].length).toBeGreaterThanOrEqual(3);
  });

  it("is IDEMPOTENT: a repaired row cannot be selected again", () => {
    const block = REPAIR_BLOCK!;
    // Selection requires a NULL set_at, which the repair removes; and the write
    // re-checks the NULL under the row lock so a concurrent writer cannot be
    // overwritten by a second run either. The re-check is the half that survives
    // any change to the lock STRENGTH, which is pinned separately below.
    expect(block).toMatch(/for no key update/);
    // THE PERMITTED write, located by the permit rather than by what it writes:
    // the probe now performs the SAME mutation deliberately, so the mutation
    // text no longer distinguishes them. What does is that only the real write
    // follows `set_config` of the row-scoped permit.
    const permitAt = block.indexOf("perform set_config('hone.admission_mode_studio_id'");
    expect(permitAt, "the row-scoped permit could not be located").toBeGreaterThan(-1);
    const update = /update public\.studios s[\s\S]*?;/.exec(block.slice(permitAt));
    expect(update, "the permitted UPDATE could not be located").toBeTruthy();
    expect(update![0], "the per-row write must re-check the NULL it is replacing").toMatch(
      /and s\.new_client_admission_mode_set_at is null/,
    );
  });

  it("takes FOR NO KEY UPDATE — the weakest lock that still serializes", () => {
    // THIS TEST USED TO PIN A FALSE OPERATIONAL GUARANTEE. Its previous revision
    // claimed FOR NO KEY UPDATE leaves `FOR KEY SHARE` traffic unblocked during
    // the apply. It does not: section 1's `alter table ... set default` takes
    // ACCESS EXCLUSIVE on `public.studios` and PostgreSQL holds it until this
    // transaction commits, so every access to the table is already blocked for
    // the whole repair — verified by reading pg_locks inside such a
    // transaction. No row-lock choice can change that, and the transaction is
    // NOT restructured to rescue the claim: serializing the apply is correct.
    //
    // WHAT IS PINNED NOW is the lock itself, on the narrow grounds that survive:
    // it is the weakest lock that still conflicts with FOR UPDATE, with another
    // FOR NO KEY UPDATE and with a plain UPDATE of the same row, which is real
    // discipline when this block is exercised OUTSIDE the migration — as the DB
    // test does, extracting and running it with no surrounding DDL lock.
    const block = REPAIR_BLOCK!;
    expect(block).toMatch(/for no key update/);
    // A bare `for update` must not reappear. Word-boundary matched so the
    // substring inside "for no key update" cannot satisfy it either way.
    expect(
      /\bfor\s+update\b/.test(block),
      "the repair must not escalate back to FOR UPDATE",
    ).toBe(false);
  });

  it("states what actually serializes the apply, and retracts the false claim", () => {
    // ASSERTED POSITIVELY, NOT AS A GREP FOR ABSENCE. A first attempt here
    // searched for the false wording and failed on the migration's own sentence
    // RETRACTING it — "an earlier revision claimed this leaves FOR KEY SHARE
    // traffic unblocked". A regex cannot tell a retraction from an assertion, so
    // the absence of a phrase is the wrong thing to pin. What matters is that the
    // true mechanism is stated and the false one is explicitly disowned.
    const lock = /FOR NO KEY UPDATE[\s\S]*?for no key update/.exec(SQL);
    expect(lock, "the lock rationale block could not be located").toBeTruthy();
    const why = lock![0];

    // 1. the real mechanism: the section-1 DDL holds ACCESS EXCLUSIVE to COMMIT,
    //    so the table is already fully blocked for the whole repair.
    expect(why).toMatch(/ACCESS EXCLUSIVE/);
    expect(why).toMatch(/until THIS transaction\s*--?\s*\n?\s*--\s*commits|until THIS transaction/i);

    // 2. the false claim is named as false rather than silently dropped, so the
    //    next reader cannot reintroduce it believing it was never considered.
    expect(why).toMatch(/CLAIM WAS FALSE/i);

    // 3. and the transaction is NOT restructured to rescue it.
    expect(why).toMatch(/NOT restructured/i);
  });
});

describe("it does not touch the legacy transition guard", () => {
  it("redefines no function and no trigger", () => {
    // The whole fix is that `set_at IS NULL` keeps meaning exactly what it
    // meant; a new row simply is not null any more. Nothing about the rule
    // changes, so nothing about the rule is rewritten.
    expect(CODE).not.toMatch(/create or replace function/i);
    expect(CODE).not.toMatch(/create trigger/i);
    expect(CODE).not.toMatch(/drop trigger/i);
  });

  it("never mentions the legacy refusal, let alone relaxes it", () => {
    expect(CODE).not.toMatch(/legacy_waitlist_cutover_required/);
  });

  it("alters only `studios`", () => {
    const altered = [...CODE.matchAll(/alter table (?:if exists )?(\S+)/gi)].map((m) =>
      m[1].replace(/;$/, ""),
    );
    expect(altered.length).toBeGreaterThan(0);
    expect([...new Set(altered)]).toEqual(["public.studios"]);
  });

  it("adds no column, index, constraint or grant", () => {
    for (const verb of [/\badd column\b/i, /create (unique )?index/i, /\badd constraint\b/i, /^\s*grant /im, /^\s*revoke /im]) {
      expect(
        CODE,
        `0205 is a default, two comments and two bounded updates - nothing else; found ${verb}`,
      ).not.toMatch(verb);
    }
  });
});
