import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ===========================================================================
// 0234 (DRAFT, PENDING SAM'S DECISION) — it carries a COPY of 0223's command,
// and this is what stops that copy from diverging.
// ===========================================================================
//
// WHY A COPY EXISTS AT ALL. `create_block_with_initial_setup` is created by
// 0223, which is UNAPPLIED, so amending 0223 would have been the smaller
// change — but 0223's copy is being propagated to other branches and must
// stay byte-identical while that happens. Carrying the change as a separate
// forward migration is the draft posture; the cost is a 334-line duplicate
// with 0223's version dead-but-present.
//
// THE RISK THAT CREATES, and the only reason this file exists: someone edits
// 0223's copy for an unrelated reason, 0234 silently overrides it, and the
// edit is lost at apply time with nothing failing. This test makes that
// impossible to do quietly — the two bodies must differ by EXACTLY the
// matched-claim hunk and its one declaration, byte for byte, and any other
// change to either file reds it.
//
// IF 0234 IS FOLDED INTO 0223 (the intended end state if Sam approves), this
// file should be DELETED along with the duplicate, not updated.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** The whole `create or replace function ... $$;` block, verbatim. */
function commandBody(sql: string): string {
  const start = sql.indexOf(
    "create or replace function public.create_block_with_initial_setup",
  );
  expect(start, "the command was not found in this migration").toBeGreaterThan(-1);
  const end = sql.indexOf("\n$$;", start) + "\n$$;".length;
  expect(end, "the command's terminator was not found").toBeGreaterThan(start);
  return sql.slice(start, end);
}

const DECLARATION =
  "  v_claim record;\n" +
  "  -- The claim matched by DIGEST rather than by key. See the hunk below.\n" +
  "  v_matched record;";

const HUNK_START =
  "\n\n    -- ===================================================================" +
  "\n    -- THE MATCHED CLAIM";

const HUNK_END = "\n  end if;\n";

describe("0234 differs from 0223 by EXACTLY the matched-claim hunk", () => {
  const original = commandBody(
    read("supabase/migrations/0223_machine_inventory_and_setup_readings.sql"),
  );
  const copy = commandBody(
    read("supabase/migrations/0234_initial_save_matched_claim.sql"),
  );

  it("both migrations actually contain the command", () => {
    // NON-VACUITY. Every assertion below compares two extracted strings; if
    // either extraction returned something trivial the comparison could pass
    // while checking nothing.
    expect(original.length).toBeGreaterThan(5000);
    expect(copy.length).toBeGreaterThan(original.length);
    expect(original.trimEnd().endsWith("$$;")).toBe(true);
    expect(copy.trimEnd().endsWith("$$;")).toBe(true);
  });

  it("removing the declaration and the hunk leaves 0223's body byte for byte", () => {
    // THE WHOLE CLAIM, as one assertion. Not a normalised or fuzzy
    // comparison: after taking out the two things 0234 is allowed to add,
    // what remains must be IDENTICAL. A stray edit to either copy — a
    // comment, a space, a changed parameter — fails here.
    expect(
      copy.includes(DECLARATION),
      "0234's `v_matched` declaration is not where this test expects it, so the comparison below would be measuring the wrong thing",
    ).toBe(true);
    const withoutDecl = copy.replace(DECLARATION, "  v_claim record;");

    const start = withoutDecl.indexOf(HUNK_START);
    expect(
      start,
      "0234's matched-claim hunk was not found by its banner",
    ).toBeGreaterThan(-1);
    const end = withoutDecl.indexOf(HUNK_END, start);
    expect(end, "the hunk's end was not found").toBeGreaterThan(start);

    const withoutHunk = withoutDecl.slice(0, start) + withoutDecl.slice(end);

    expect(
      withoutHunk,
      "0234's copy of the command has diverged from 0223's beyond the matched-claim hunk. If 0223 was edited deliberately, that edit must be made in BOTH until 0234 is folded in — this copy would otherwise override it silently at apply time.",
    ).toBe(original);
  });

  it("the hunk is the matched-claim branch and nothing else", () => {
    // What the allowed difference actually DOES, so "differs by one hunk"
    // cannot be satisfied by one hunk of something else.
    const withoutDecl = copy.replace(DECLARATION, "  v_claim record;");
    const start = withoutDecl.indexOf(HUNK_START);
    const hunk = withoutDecl.slice(start, withoutDecl.indexOf(HUNK_END, start));

    expect(hunk).toMatch(/c\.payload_digest = v_digest/);
    expect(hunk).toMatch(/into v_matched/);
    expect(hunk).toMatch(/'reused', true/);
    // It must not create anything.
    expect(
      hunk,
      "the allowed hunk writes; it is only supposed to answer with what already exists",
    ).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/i);
  });

  it("0234 says it is a draft and names its fold-back", () => {
    // The posture is load-bearing: this migration must not be applied as a
    // permanent shape, and the next reader has to learn that from the file
    // rather than from a message thread.
    const sql = read("supabase/migrations/0234_initial_save_matched_claim.sql");
    expect(sql).toMatch(/PENDING SAM'S DECISION/);
    expect(sql).toMatch(/NOT TO BE APPLIED AS-IS/);
    expect(sql).toMatch(/FOLD IT INTO 0223 BEFORE ANY APPLY/);
  });
});
