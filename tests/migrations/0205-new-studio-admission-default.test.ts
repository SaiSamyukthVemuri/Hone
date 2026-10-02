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
// shape of the change — one default, two comments, ONE BOUNDED `update
// public.studios` and no other DML, and no logic edit. It cannot prove
// behaviour, because SQL text is not a running database.
//
// An earlier revision of this header said "no DML", which was true until the
// census-to-apply window repair was added and false afterwards. The claim is a
// BOUND now, not an absence, and the assertions below enforce it as one. The
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
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. The "nothing above me" tripwire is served centrally for
    // every older migration, which is why none of them repeats it.
    expect(isRepoMax(VERSION), "0205 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0205").toEqual([]);
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
    // default for FUTURE inserts only. Pre-fix studios must keep set_at NULL and
    // keep their legacy semantics.
    expect(CODE).toMatch(/alter column new_client_admission_mode_set_at set default/);
    expect(CODE).not.toMatch(/add column[^;]*new_client_admission_mode_set_at/);
  });

  it("its ONLY data manipulation is the bounded window repair", () => {
    // THE CENSUS WAS A POINT IN TIME. It found nothing to repair, but 0204 is
    // applied while 0205 is not, so a studio created in the window BETWEEN the
    // census and this apply is born open/NULL and the default cannot reach it —
    // `SET DEFAULT` only governs inserts that come after it. Section 3 repairs
    // that window, so the earlier "zero DML" claim is retired.
    //
    // The bound still has to be asserted, which is what this is: ONE update,
    // against studios, and no other verb at all.
    const updates = [...CODE.matchAll(/\bupdate\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(updates, "0205 writes exactly one table, once").toEqual(["studios"]);
    for (const verb of [/\binsert\s+into\b/i, /\bdelete\s+from\b/i, /\btruncate\b/i]) {
      expect(CODE, `0205 may only UPDATE; found ${verb}`).not.toMatch(verb);
    }
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
    // Seven ids, because the census enumerated seven studios.
    const ids = [...block.matchAll(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'::uuid/g)];
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

  it("FAILS CLOSED three ways: guard present, model intact, post-condition met", () => {
    const block = REPAIR_BLOCK!;
    // 1. the guard must exist before anything is written
    expect(block).toMatch(/studios_admission_mode_guard/);
    expect(block).toMatch(/pg_trigger/);
    // 2. an unstamped row above the boundary that is not a plain system default
    //    means the model is wrong, and the repair refuses rather than guessing
    expect(block).toMatch(/v_anomalous/);
    // 3. nothing in scope may still be NULL afterwards
    expect(block).toMatch(/v_left/);
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
    const update = /update public\.studios[\s\S]*?;/.exec(block)![0];
    expect(update, "the per-row write must re-check the NULL it is replacing").toMatch(
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
      expect(CODE, `0205 is a default + comments only; found ${verb}`).not.toMatch(verb);
    }
  });
});

describe("the comments stop defining non-null set_at as an owner's choice", () => {
  it("rewrites both column comments forward, because 0204 is frozen", () => {
    const comments = [...SQL.matchAll(/comment on column public\.studios\.(\w+) is/g)].map(
      (m) => m[1],
    );
    expect(new Set(comments)).toEqual(
      new Set(["new_client_admission_mode_set_at", "new_client_admission_mode_set_by"]),
    );
  });

  it("set_at's comment says INITIALIZED, and names set_by as the discriminator", () => {
    const c = /comment on column public\.studios\.new_client_admission_mode_set_at is([\s\S]*?);/.exec(
      SQL,
    );
    expect(c, "set_at has no comment").toBeTruthy();
    const body = c![1];
    expect(body).toMatch(/initialized/i);
    expect(body).toMatch(/new_client_admission_mode_set_by/);
    // And it must NOT still claim non-null means an owner chose.
    expect(body).not.toMatch(/no owner has\s+'?\s*'?chosen a mode/i);
  });

  it("set_by's comment distinguishes system initialization from an owner change", () => {
    const c = /comment on column public\.studios\.new_client_admission_mode_set_by is([\s\S]*?);/.exec(
      SQL,
    );
    expect(c, "set_by has no comment").toBeTruthy();
    const body = c![1];
    expect(body).toMatch(/system-initialized|system initialization/i);
    expect(body).toMatch(/predates 0204|set_at NULL/i);
  });

  it("keeps the reason there is no foreign key on set_by", () => {
    // 0204 recorded it after CI run 36729106946: a second
    // studios<->practitioners relationship breaks the PostgREST embed. Replacing
    // the comment must not drop the lesson.
    const c = /comment on column public\.studios\.new_client_admission_mode_set_by is([\s\S]*?);/.exec(
      SQL,
    );
    expect(c![1]).toMatch(/PostgREST embed ambiguous|NOT a foreign key/i);
  });
});
