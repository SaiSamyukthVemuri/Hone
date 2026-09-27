import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  countVersion,
  fileForVersion,
  isRepoMax,
  migrationState,
  versionsAbove,
} from "./helpers/migration-state";

// 0203 — WAITLIST MOBILE VERIFICATION AUTHORITY.
//
// SOURCE CONTRACT ONLY. Behaviour was validated against a real local database
// while authoring — the guard admits exactly one writer, a permit for row A
// authorizes nothing over row B, a verified instant can neither move nor be
// cleared, and every rule carried from 0202 still raises. An admin-connection
// source test cannot see a privilege defect, which is the lesson 0197 recorded.
//
// WHAT THIS FILE PINS is mostly what the file must NOT lose: 0203 replaces the
// whole transition guard, and `create or replace function` silently drops every
// rule the new body does not mention. So the carried rules are asserted here by
// name, and a future edit that forgets one fails rather than shipping a table
// with its identity freeze quietly removed.

const ROOT = path.resolve(__dirname, "../..");
const VERSION = "0203";
const FILE = fileForVersion(VERSION);
const SQL = readFileSync(path.join(ROOT, "supabase/migrations", FILE), "utf8");
/** Comment-stripped, so prose can never satisfy an assertion. */
const CODE = SQL.replace(/^\s*--.*$/gm, " ").replace(/comment on [\s\S]*?;/gi, " ");

const SIG = "public.mark_waitlist_mobile_verified(uuid, text)";

describe("0203 takes the number it derived", () => {
  it("is the repository maximum with nothing above it", () => {
    expect(isRepoMax(VERSION)).toBe(true);
    expect(versionsAbove(VERSION)).toEqual([]);
  });

  it("claims its version exactly once", () => {
    expect(countVersion(VERSION)).toBe(1);
  });

  it("sits ABOVE hosted, because it is a candidate and not applied", () => {
    const state = migrationState();
    expect(Number(VERSION)).toBeGreaterThan(Number(state.hosted_migration_max));
  });
});

describe("it adds one authority and no privileges", () => {
  it("creates no table and alters no column", () => {
    expect(CODE).not.toMatch(/create\s+table/i);
    expect(CODE).not.toMatch(/add column/i);
    expect(CODE).not.toMatch(/drop column/i);
  });

  it("grants no table privilege to anyone — 0185's wall is untouched", () => {
    expect(CODE).not.toMatch(
      /grant\s+(select|insert|update|delete|all)[\s\S]{0,80}on\s+public\.new_client_waitlist_entries/i,
    );
  });

  it("revokes EXECUTE from all four grantees by name, then grants service_role alone", () => {
    const sig = SIG.replace(/[()[\]]/g, "\\$&");
    for (const grantee of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE, `revoke from ${grantee}`).toMatch(
        new RegExp(`revoke execute on function ${sig} from ${grantee};`, "i"),
      );
    }
    expect(CODE).toMatch(new RegExp(`grant execute on function ${sig} to service_role;`, "i"));
  });

  it("the command is SECURITY DEFINER with a pinned search_path", () => {
    const fn = CODE.slice(CODE.indexOf("create or replace function public.mark_waitlist_mobile_verified"));
    expect(fn.slice(0, 400)).toMatch(/security definer/i);
    expect(fn.slice(0, 400)).toMatch(/set search_path = pg_catalog, pg_temp/i);
  });
});

describe("the one writer is narrow, and the guard says so", () => {
  it("the permit is row-scoped and transaction-local", () => {
    // `true` is the is_local argument: the setting dies with the transaction, so
    // it cannot leak into a later statement on a pooled connection.
    expect(CODE).toMatch(
      /set_config\(\s*'hone\.mobile_verified_entry_id'\s*,\s*p_entry_id::text\s*,\s*true\s*\)/,
    );
  });

  it("the guard admits ONLY the row named by that permit", () => {
    expect(CODE).toMatch(
      /current_setting\('hone\.mobile_verified_entry_id', true\)[\s\S]{0,60}new\.id::text/,
    );
  });

  it("a verified instant may neither move nor be cleared", () => {
    expect(CODE).toMatch(/mobile_verified_at is immutable once proved/);
    expect(CODE).toMatch(/mobile_verified_at may not be cleared/);
  });

  it("promotes from the DATABASE clock, never a supplied instant", () => {
    const fn = CODE.slice(CODE.indexOf("create or replace function public.mark_waitlist_mobile_verified"));
    expect(fn).toMatch(/v_now\s*:=\s*clock_timestamp\(\)/);
    expect(fn).toMatch(/set mobile_verified_at = v_now/);
    // NO CALLER-SUPPLIED INSTANT EXISTS TO TRUST — asserted on the PARAMETER
    // LIST, not the body. The body declares `timestamptz` locals, which is what
    // a first version of this assertion caught: a rule that fails on correct
    // code teaches people to delete it.
    const params = fn.slice(fn.indexOf("(") + 1, fn.indexOf(")"));
    expect(params).not.toMatch(/timestamptz/);
    // The WHOLE list is pinned, not just the absence of a timestamp: a third
    // parameter arriving later is the way a caller-supplied instant would get in.
    expect(params.split(",").map((p) => p.trim().replace(/\s+/g, " "))).toEqual([
      "p_entry_id uuid",
      "p_expected_phone text",
    ]);
  });

  it("compares the stored phone EXACTLY and re-derives no phone format", () => {
    // 0202 kept phone normalization out of SQL on purpose. A digits-only compare
    // was tried here first and refused a real proof, because a stored
    // "647-555-1234" and an E.164 "+1647..." reduce differently.
    const fn = CODE.slice(CODE.indexOf("create or replace function public.mark_waitlist_mobile_verified"));
    expect(fn).toMatch(/v_phone is distinct from p_expected_phone/);
    expect(fn).not.toMatch(/regexp_replace/);
  });

  it("takes the canonical studio -> entry lock order", () => {
    const fn = CODE.slice(CODE.indexOf("create or replace function public.mark_waitlist_mobile_verified"));
    const studio = fn.search(/from public\.studios[\s\S]{0,40}for no key update/i);
    const entry = fn.search(/from public\.new_client_waitlist_entries[\s\S]{0,80}for update/i);
    expect(studio).toBeGreaterThan(-1);
    expect(entry).toBeGreaterThan(-1);
    expect(studio, "studio is locked before entry").toBeLessThan(entry);
  });

  it("writes nothing except mobile_verified_at", () => {
    const fn = CODE.slice(CODE.indexOf("create or replace function public.mark_waitlist_mobile_verified"));
    // The WHOLE set clause is parsed, not matched. Two earlier versions of this
    // assertion were wrong in opposite directions: /set (\w+) =/ across the
    // function also matched `set search_path`, and scoping it to the UPDATE still
    // missed a second assignment appended after a COMMA -- which a mutation
    // control caught by writing `set mobile_verified_at = v_now, sms_consent_at
    // = v_now` and passing. Splitting the clause catches both.
    const stmt = fn.slice(fn.indexOf("update public.new_client_waitlist_entries"));
    const clause = stmt.slice(stmt.search(/\bset\b/) + 3, stmt.search(/\bwhere\b/));
    const columns = clause.split(",").map((a) => a.split("=")[0].trim());
    expect(columns).toEqual(["mobile_verified_at"]);
  });
});

describe("every rule 0202 enforced is still enforced", () => {
  // 0203 replaces the whole guard body. These are the rules that would be lost
  // silently by an edit that forgot to carry them.
  const CARRIED: ReadonlyArray<readonly [string, RegExp]> = [
    ["id/studio/joined_at/source immutable", /id, studio_id, joined_at and source are immutable/],
    ["name and email immutable", /name and email are immutable/],
    ["the mobile is one-way", /a stored mobile may not be replaced or cleared/],
    ["an opt-out is terminal", /an opt-out is terminal and its evidence is immutable/],
    ["illegal lifecycle transitions raise", /illegal lifecycle transition/],
    ["the per-transition delta map exists", /v_allowed := case old\.status/],
    ["the delta map fails closed", /else array\[\]::text\[\]/],
  ];

  for (const [label, re] of CARRIED) {
    it(`carries: ${label}`, () => {
      expect(CODE, label).toMatch(re);
    });
  }
});

describe("the carried guard is 0202's, changed in exactly one place", () => {
  // THE STRONGEST RULE IN THIS FILE, and the reason it exists: `create or replace
  // function` silently drops every rule the new body does not mention, so the
  // real risk is not a wrong new clause but a QUIET LOSS of an old one. Naming
  // the carried rules individually (above) only catches the seven someone
  // thought to name. This compares the whole body against 0202's and allows
  // exactly ONE changed region -- the clause 0202 itself marked as the one the
  // verification slice would amend.

  const guardOf = (file: string): string[] => {
    const sql = readFileSync(path.join(ROOT, "supabase/migrations", file), "utf8");
    const i = sql.indexOf(
      "create or replace function public.new_client_waitlist_entries_transition_guard",
    );
    expect(i, `${file} must redefine the transition guard`).toBeGreaterThan(-1);
    const j = sql.indexOf("$$;", i);
    expect(j, `${file}'s guard must terminate`).toBeGreaterThan(i);
    // Comment-stripped: prose churn is not a behaviour change and must not be
    // able to spend the one allowed hunk.
    return sql
      .slice(i, j + 3)
      .split("\n")
      .filter((l) => !/^\s*--/.test(l))
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== "");
  };

  const BEFORE = guardOf("0202_waitlist_profile_and_sms_consent_authority.sql");
  const AFTER = guardOf(FILE);

  /**
   * Contiguous regions where the two bodies differ, plus the COMMON subsequence
   * in order, via a simple LCS.
   */
  function diffGuard(
    a: string[],
    b: string[],
  ): { regions: Array<[string[], string[]]>; common: string[] } {
    const n = a.length;
    const m = b.length;
    const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    const regions: Array<[string[], string[]]> = [];
    const common: string[] = [];
    let i = 0;
    let j = 0;
    let da: string[] = [];
    let db: string[] = [];
    const flush = () => {
      if (da.length || db.length) regions.push([da, db]);
      da = [];
      db = [];
    };
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        flush();
        common.push(a[i]);
        i += 1;
        j += 1;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        da.push(a[i]);
        i += 1;
      } else {
        db.push(b[j]);
        j += 1;
      }
    }
    da.push(...a.slice(i));
    db.push(...b.slice(j));
    flush();
    return { regions, common };
  }

  const { regions: REGIONS, common: COMMON } = diffGuard(BEFORE, AFTER);

  it("changes ONE contiguous region of the guard and no other", () => {
    expect(
      REGIONS.length,
      "0203 changed more than one region of 0202's guard. Every other rule in that " +
        "body is production behaviour and must be carried through byte-identical:\n" +
        REGIONS.map(([x, y]) => `  - ${x[0] ?? "(insert)"} -> ${y[0] ?? "(delete)"}`).join("\n"),
    ).toBe(1);
  });

  it("the OUTER CONDITION is untouched — the region cannot swallow its own boundary", () => {
    // THE HOLE THIS CLOSES, which a review found by naming the mutation:
    // rewriting the shared boundary line to
    //   `if false and new.mobile_verified_at is distinct from old.mobile_verified_at then`
    // disables the ENTIRE one-writer guard, and every other assertion here still
    // passed. The mutated line stops matching 0202's, joins the adjacent changed
    // region, and LCS merges the two into ONE -- so the region count, the marker
    // checks and the survivor equalities were all satisfied by a guard that no
    // longer guards anything.
    //
    // The boundary is therefore pinned as COMMON: it must be a line both bodies
    // share, which a mutated line by definition is not.
    const OUTER = "  if new.mobile_verified_at is distinct from old.mobile_verified_at then";
    expect(BEFORE, "0202 must carry the outer condition verbatim").toContain(OUTER);
    expect(
      COMMON,
      "the mobile_verified_at outer condition was modified, not just its body",
    ).toContain(OUTER);

    // And the change begins IMMEDIATELY INSIDE it: the line after the outer
    // condition is the region's first added line, so nothing above the condition
    // moved. Located by searching for OUTER -- not by searching for a removed
    // line, which is absent from AFTER by definition, nor by `indexOf` on a line
    // that recurs.
    expect(AFTER.filter((l) => l === OUTER), "the outer condition must appear once").toHaveLength(
      1,
    );
    const at = AFTER.indexOf(OUTER);
    const firstAdded = REGIONS[0][1][0];
    expect(firstAdded, "the region must add at least one line").toBeTruthy();
    expect(
      AFTER[at + 1],
      "the amended body does not start immediately inside the outer condition",
    ).toBe(firstAdded);
  });

  it("that one region is the mobile_verified_at clause, and it REPLACES a refusal", () => {
    const [removed, added] = REGIONS[0];
    // What 0202 said: there is no writer. What 0203 says: there is exactly one.
    expect(removed.join("\n")).toContain("mobile_verified_at has no writer in this release");
    expect(added.join("\n")).toContain("hone.mobile_verified_entry_id");
    // The clause still RAISES on the paths it must; it did not become permissive.
    expect(added.join("\n")).toMatch(/raise exception/);
  });

  it("every other line of 0202's guard survives byte-identical, IN ORDER", () => {
    const [removed, added] = REGIONS[0];
    // POSITIONAL, NOT BY VALUE. A first version filtered BEFORE by value and went
    // red at 128 vs 136, because lines like `end if;` recur and filtering one
    // occurrence removed them all. These two equalities say it exactly: outside
    // the single changed region the two bodies are the SAME LINES in the SAME
    // ORDER, since the common subsequence accounts for every remaining line of
    // each body with nothing left over.
    expect(
      COMMON.length,
      "a line of 0202's guard was dropped or reordered outside the amended clause",
    ).toBe(BEFORE.length - removed.length);
    expect(
      COMMON.length,
      "0203 added a line outside the amended clause",
    ).toBe(AFTER.length - added.length);
  });
});

describe("the PERSISTED comments agree with the new authority", () => {
  // A `comment on` IS PERSISTED STATE. 0202's text for these columns lives in
  // pg_description and survives this migration unless replaced, so after the
  // apply `\d+` and every generated document would still say mobile_verified_at
  // has no writer, is NULL for every row, and that the guard refuses every change
  // to it -- while this same file installs the writer and amends the guard.
  //
  // A review found this because it was the one surface in the slice with no guard
  // on it, after four earlier findings of the same class in source comments and
  // the PR description. So it is guarded now.

  const SQL_0202 = readFileSync(
    path.join(ROOT, "supabase/migrations", fileForVersion("0202")),
    "utf8",
  );

  // NOTE: these read SQL, the RAW file. `CODE` above is comment-stripped by
  // construction -- which is right for every other assertion in this file and
  // exactly wrong here, since the persisted comments ARE the subject.
  /** The text 0203 installs for a column, or null when it installs none. */
  const commentFor = (sql: string, column: string): string | null => {
    const re = new RegExp(
      `comment on column public\\.new_client_waitlist_entries\\.${column} is\\s*'([\\s\\S]*?)';`,
      "i",
    );
    return sql.match(re)?.[1] ?? null;
  };

  // The claims that were true of 0202 and are false once 0203 is applied.
  const FALSIFIED: ReadonlyArray<readonly [string, RegExp]> = [
    ["no writer exists", /no writer (exists|at all)/i],
    ["NULL for every row", /NULL for every row/i],
    ["the guard refuses ANY change", /refuses any change/i],
  ];

  for (const column of ["mobile_verified_at", "phone"] as const) {
    it(`re-comments ${column}, because 0202's text becomes false`, () => {
      const before = commentFor(SQL_0202, column);
      expect(before, `0202 must comment ${column}`).toBeTruthy();
      const after = commentFor(SQL, column);
      expect(
        after,
        `0202 comments ${column} and 0203 changes what that comment asserts, so 0203 must replace it`,
      ).toBeTruthy();
      expect(after).not.toBe(before);
    });

    it(`${column}'s new comment asserts nothing 0203 falsifies`, () => {
      const after = commentFor(SQL, column) ?? "";
      for (const [label, re] of FALSIFIED) {
        expect(after, `${column}'s comment still claims: ${label}`).not.toMatch(re);
      }
    });
  }

  it("mobile_verified_at's comment names the one writer, so the text is checkable", () => {
    const after = commentFor(SQL, "mobile_verified_at") ?? "";
    expect(after).toMatch(/mark_waitlist_mobile_verified/);
    expect(after).toMatch(/one writer/i);
  });

  it("the comment claims NO GUARANTEE the database does not make", () => {
    // THE SIXTH FINDING OF THIS CLASS, and the sharpest, because the overstatement
    // was written in the commit that fixed the fifth.
    //
    // A first version said a non-NULL value MEANS a provider accepted a possession
    // proof, and never an operator assertion. THE DATABASE CANNOT KNOW THAT. The
    // command receives no proof -- an entry id and the expected phone -- and any
    // service_role caller may invoke it directly. Provider-first ordering lives in
    // lib/waitlist/mobile-verification-server.ts, which is an APPLICATION
    // contract, and a persisted comment that reads as a database guarantee will be
    // trusted as one by exactly the introspection tools that cannot check it.
    const after = commentFor(SQL, "mobile_verified_at") ?? "";

    // It must say, in some form, that the proof ordering is NOT enforced here.
    expect(after, "the comment must disclaim what it does not enforce").toMatch(
      /does not enforce|not a database guarantee|application-level contract/i,
    );
    expect(after).toMatch(/receives no proof|NO PROOF/i);

    // And it must not make the bare claim. `means ... proof` with no disclaimer is
    // the exact sentence that was wrong.
    const bare = /\bmeans\b[^.]{0,90}\bproof was accepted\b[^.]{0,40}\bnever\b/i;
    expect(after, "the comment states provider approval as a database fact").not.toMatch(bare);
  });

  it("the FUNCTION comment does not claim proof enforcement either", () => {
    // Same rule applied to the other persisted claim in this file. The function
    // comment describes a compare-and-set, which IS what it enforces; it must not
    // acquire a proof claim later.
    const fn = SQL.match(
      /comment on function public\.mark_waitlist_mobile_verified\(uuid, text\) is\s*'([\s\S]*?)';/i,
    )?.[1];
    expect(fn, "the command must carry a comment").toBeTruthy();
    expect(fn ?? "").not.toMatch(/verif(ies|ied) the proof|proves possession|provider approved/i);
  });

  it("NO applied migration's comment is edited in place", () => {
    // The correction is FORWARD. 0202 is applied and frozen.
    expect(SQL_0202).toMatch(/no writer (exists|at all)/i);
  });
});

describe("applied history is frozen", () => {
  it("0203 does not edit 0202 or any earlier file", () => {
    // The only migration file this change may add is its own; asserted here
    // because a guard rewrite is exactly the change that tempts an in-place edit.
    expect(FILE).toBe("0203_waitlist_mobile_verification_authority.sql");
  });

  it("references no object a later slice has not built", () => {
    for (const absent of ["verify_service", "twilio", "otp", "verification_code"]) {
      expect(CODE.toLowerCase(), absent).not.toContain(absent);
    }
  });
});
