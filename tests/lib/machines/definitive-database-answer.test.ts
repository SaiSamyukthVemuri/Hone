import { describe, expect, it } from "vitest";

import { isDefinitiveDatabaseAnswer } from "@/lib/machines/save-attempt";

// ===========================================================================
// MPX-03 — DID THE DATABASE ANSWER, OR DID WE NEVER HEAR BACK?
//
// Codex #860 4301722737 / 4301722740. A lost response is not always a thrown
// exception: when the connection to PostgREST drops AFTER the command
// commits, supabase-js can report the transport failure in the returned
// `error` field instead of rejecting. Both machine save paths treated every
// `error` as a definitive refusal, which unfreezes the draft and releases the
// retry key — so the next save mints a new key and appends a DUPLICATE
// immutable capture.
//
// THE ASYMMETRY IS THE DESIGN, and these cases are chosen to pin it:
//   * a refusal misread as unknown costs one redundant retry, which is
//     answered with the same refusal (carrying a SQLSTATE) and then
//     unfreezes normally — it self-corrects;
//   * an unknown misread as a refusal costs a duplicate clinical record,
//     which is immutable.
// So anything not provably from the database is unknown.
// ===========================================================================

describe("a definitive database answer carries a code", () => {
  const DEFINITIVE: Array<[string, string]> = [
    ["23505", "unique_violation — the duplicate-key refusal"],
    ["23514", "check_violation — what 0223's own `raise` produces"],
    ["P0001", "raise_exception — a plpgsql `raise exception` with no errcode"],
    ["42501", "insufficient_privilege — an RLS or grant refusal"],
    ["25P01", "no_active_sql_transaction"],
    ["PGRST116", "PostgREST answered: no rows"],
    ["PGRST301", "PostgREST answered: JWT problem"],
  ];

  for (const [code, why] of DEFINITIVE) {
    it(`${code} is definitive (${why})`, () => {
      expect(isDefinitiveDatabaseAnswer({ code })).toBe(true);
    });
  }
});

describe("anything else means the outcome is UNKNOWN", () => {
  const UNKNOWN: Array<[unknown, string]> = [
    [
      { code: "", message: "TypeError: fetch failed" },
      "the exact shape supabase-js reports on a dropped connection",
    ],
    [{ message: "TypeError: fetch failed" }, "no code field at all"],
    [{ code: null }, "an explicitly null code"],
    [{ code: "   " }, "whitespace, which is not a code"],
    [{ code: "FetchError" }, "a transport error name, not a SQLSTATE"],
    [{ code: "ECONNRESET" }, "a socket error — 10 chars, not 5"],
    [{ code: "ETIMEDOUT" }, "a timeout, which is the ambiguous case itself"],
    [{ code: "500" }, "a bare HTTP status is not a SQLSTATE"],
    [null, "no error object"],
    [undefined, "nothing at all"],
  ];

  for (const [error, why] of UNKNOWN) {
    it(`treated as unknown: ${why}`, () => {
      expect(
        isDefinitiveDatabaseAnswer(error as { code?: string | null } | null),
      ).toBe(false);
    });
  }

  it("a lowercase five-character code is NOT assumed to be a SQLSTATE", () => {
    // SQLSTATE is uppercase and numeric. Accepting anything five characters
    // long would classify an arbitrary transport token as definitive, which
    // is the failure direction that costs a clinical record.
    expect(isDefinitiveDatabaseAnswer({ code: "abcde" })).toBe(false);
  });
});
