import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  countVersion,
  fileForVersion,
  isRepoMax,
  versionsAbove,
} from "./helpers/migration-state";

// ===========================================================================
// Migration 0209 — WAIT-v4 PR0. The SQL candidate window crosses local
// midnight too.
//
// WHAT THIS CLOSES. `studio_calendar_reservations` stores an appointment's
// ACTUAL end (0152); every consumer re-applies the studio buffer to reach its
// PROTECTED end. Both public slot CANDIDATE functions filtered that read on
// `cr.ends_at > v_win_start` — the actual end — so a 23:50 appointment under a
// 30-minute buffer, protected to 00:20, was never loaded for the following day
// and LOCAL MIDNIGHT WAS OFFERED.
//
// OFFER-TRUTH, NOT SAFETY. `validate_public_booking_slot`,
// `validate_public_reschedule_slot` and 0152's `enforce_appointment_buffer`
// read reservations with NO window filter at all and already refused midnight,
// so no bad write was ever possible. The defect was that a client was shown a
// slot the authority would reject.
//
// SOURCE CONTRACT ONLY — and the contract here is unusually literal. The
// behavioural claims (the SQL no longer offers midnight, it still offers the
// protected end itself, a zero-buffer studio is unaffected, and TS and SQL
// agree as SETS) are proved against a real database in
// tests/db/public-booking-slot-parity.db.test.ts. What this file proves is
// that nothing ELSE in two large function bodies moved: it re-extracts both
// bodies from the frozen 0170/0171 text they were copied from and asserts the
// line delta is EXACTLY the three intended edits. That is the assertion worth
// having, because a `create or replace` of a 150-line body is precisely where
// an unrelated change hides — and it also goes red if anyone edits an APPLIED
// migration, which §5 forbids.
// ===========================================================================

const VERSION = "0209";
const FILE = "0209_public_slot_candidate_buffer_window.sql";
const SQL = readFileSync(
  path.join(process.cwd(), "supabase/migrations", FILE),
  "utf8",
);
// LINE comments before anything else — a block-comment-first strip silently
// eats real code here. Comment text must never satisfy a code assertion.
const CODE = SQL.replace(/^\s*--.*$/gm, " ");

const FUNCTIONS = [
  {
    name: "public_booking_slot_candidates",
    sig: "(uuid, date, integer)",
    origin: "0170_public_appointment_command.sql",
  },
  {
    name: "public_reschedule_slot_candidates",
    sig: "(uuid, date, integer, uuid, uuid)",
    origin: "0171_public_reschedule_command_v2.sql",
  },
] as const;

/** The full `create or replace … $$;` text of one function in `src`. */
function bodyOf(src: string, name: string): string {
  const head = `create or replace function public.${name}(`;
  const start = src.indexOf(head);
  expect(start, `${name} is not defined in this file`).toBeGreaterThan(-1);
  const end = src.indexOf("\n$$;", start);
  expect(end, `${name} has no terminating $$;`).toBeGreaterThan(start);
  return src.slice(start, end + "\n$$;".length);
}

/** Executable lines only: comment-only and blank lines carry no behaviour. */
function codeLines(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("--"));
}

/** Multiset difference — a plain `includes` filter would miss a line whose
 *  COUNT changed, which is how a duplicated predicate would slip through. */
function delta(before: string[], after: string[]) {
  const tally = (ls: string[]) => {
    const m = new Map<string, number>();
    for (const l of ls) m.set(l, (m.get(l) ?? 0) + 1);
    return m;
  };
  const b = tally(before);
  const a = tally(after);
  const added: string[] = [];
  const removed: string[] = [];
  for (const [l, n] of a) {
    const extra = n - (b.get(l) ?? 0);
    for (let i = 0; i < extra; i++) added.push(l);
  }
  for (const [l, n] of b) {
    const gone = n - (a.get(l) ?? 0);
    for (let i = 0; i < gone; i++) removed.push(l);
  }
  return { added, removed };
}

describe("0209 sits correctly in the migration sequence", () => {
  it("is the repository maximum, and nothing sits above it", () => {
    // Only the CURRENT maximum migration's own test may assert this — see
    // CLAUDE.md §2. It was handed over from
    // tests/migrations/0207-sms-invitation-claim-serialized.test.ts in the same
    // change that authored this file; the older test now asserts the inverse,
    // derived rather than pinned. The claim travelled 0205 -> 0209 -> 0207 ->
    // here while this lane was parked, which is exactly why it is never pinned
    // to a literal successor.
    expect(isRepoMax(VERSION), "0209 is no longer the repo max").toBe(true);
    expect(versionsAbove(VERSION), "something was added above 0209").toEqual([]);
  });

  it("is allocated exactly once, at the number the census derived", () => {
    expect(countVersion(VERSION)).toBe(1);
    expect(fileForVersion(VERSION)).toBe(FILE);
  });

  it("opens its own transaction with a lock timeout", () => {
    // `supabase db push` does NOT wrap a file in a transaction, so a bare
    // `SET LOCAL` emits 25P01 and never arms. See CLAUDE.md §5.
    expect(CODE).toMatch(/^begin;/m);
    expect(CODE).toMatch(/^commit;/m);
    expect(CODE).toMatch(/^set local lock_timeout = '5s';/m);
  });
});

describe("0209 changes two function bodies and NOTHING else", () => {
  it("contains exactly two statements that are not grants", () => {
    const creates = CODE.match(/^create or replace function/gm) ?? [];
    expect(creates).toHaveLength(2);
  });

  it("carries no schema change of any kind", () => {
    expect(CODE).not.toMatch(/\bcreate (table|index|type|policy|trigger)\b/i);
    expect(CODE).not.toMatch(/\balter (table|type|policy)\b/i);
    expect(CODE).not.toMatch(/\bdrop\b/i);
    expect(CODE).not.toMatch(/\badd (column|constraint)\b/i);
  });

  it("carries ZERO migration-level DML", () => {
    // A SELECT inside a function body is the function's own logic; a top-level
    // write is a data change, and this migration makes none.
    expect(CODE).not.toMatch(/^\s*(insert|update|delete)\s+/im);
  });
});

describe.each(FUNCTIONS)("0209 · $name", ({ name, sig, origin }) => {
  const ORIGIN_SQL = readFileSync(
    path.join(process.cwd(), "supabase/migrations", origin),
    "utf8",
  );
  const before = codeLines(bodyOf(ORIGIN_SQL, name));
  const after = codeLines(bodyOf(SQL, name));
  const { added, removed } = delta(before, after);

  it("is re-created from its frozen origin with EXACTLY the three edits", () => {
    // The whole point of this file. Four executable lines appear — one
    // declaration, one derived assignment, two corrected predicates — and the
    // two old predicates disappear. Anything else in either body having moved
    // reds here, which is the only cheap guard against an unrelated change
    // riding along inside a 150-line `create or replace`.
    expect(removed.sort()).toEqual(
      ["and cr.ends_at   > v_win_start", "and cr2.ends_at   > v_win_start"].sort(),
    );
    expect(added.sort()).toEqual(
      [
        "v_res_win_start timestamptz;",
        "v_res_win_start := v_win_start - make_interval(mins => v_buffer);",
        "and cr.ends_at   > v_res_win_start",
        "and cr2.ends_at   > v_res_win_start",
      ].sort(),
    );
  });

  it("derives the reservation window from the buffer, never a literal", () => {
    // A hard-coded `interval '30 minutes'` would pass every behavioural case
    // in the parity suite, because that suite's fixture buffer IS 30. The
    // bound must come from the studio's own buffer or it is a coincidence.
    const body = bodyOf(SQL, name);
    expect(body).toContain(
      "v_res_win_start := v_win_start - make_interval(mins => v_buffer)",
    );
    expect(body).not.toMatch(/v_res_win_start := [^;]*interval '\d+/);
  });

  it("leaves the UPPER bound alone — only the lower one was wrong", () => {
    const body = bodyOf(SQL, name);
    expect(body).toContain("v_win_end   := v_win_start + interval '36 hours';");
    expect(body).not.toContain("v_win_end   := v_res_win_start");
  });

  it("keeps its signature, so no overload is created", () => {
    // `create or replace` with a changed argument list creates a SECOND
    // function instead of replacing the first, and the old body keeps serving
    // every existing caller.
    const header = bodyOf(SQL, name).split("returns")[0]!;
    const args = header
      .replace(/^create or replace function public\.\w+\(/, "")
      .replace(/\)\s*$/, "");
    for (const t of sig.slice(1, -1).split(", ")) {
      expect(args, `${name} lost a ${t} argument`).toContain(t);
    }
  });

  it("revokes EXECUTE from all four roles BY NAME, and re-grants only service_role", () => {
    // Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
    // authenticated AND service_role at function-create time, and `create or
    // replace` re-triggers it. Missing one role was the 0129 (`anon`) and 0164
    // (`service_role`) defect. These two commands are service-role only.
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      expect(CODE).toContain(
        `revoke execute on function public.${name}${sig} from ${role};`,
      );
    }
    expect(CODE).toContain(
      `grant execute on function public.${name}${sig} to service_role;`,
    );
  });
});

describe("0209 asserts the grant posture exhaustively", () => {
  it("has exactly eight revokes and two grants — four roles times two functions", () => {
    expect(CODE.match(/^revoke execute on function/gm) ?? []).toHaveLength(8);
    expect(CODE.match(/^grant execute on function/gm) ?? []).toHaveLength(2);
  });

  it("grants EXECUTE to nobody but service_role", () => {
    const grants = CODE.match(/^grant execute on function[^\n]*/gm) ?? [];
    for (const g of grants) expect(g).toMatch(/to service_role;$/);
  });

  it("touches no table grant", () => {
    expect(CODE).not.toMatch(/(revoke|grant)[^\n]* on table/i);
  });
});
