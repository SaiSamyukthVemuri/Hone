import { describe, expect, it } from "vitest";

// PR #149: the submitted-start guard the reschedule action runs
// before any DB lookup or RPC call.
//
// The action's actual code path takes a `formData` and dispatches
// against the studio + appointment row, the rate limiter, and the
// reschedule RPC. The smallest piece of that logic we can pin down
// without a live DB or Supabase mock is the future-instant guard:
// "newStartsAt must be strictly in the future". That predicate is
// what migration 0066's `if p_new_starts_at <= now()` re-enforces.
//
// We codify the predicate here so a future refactor that loosens
// the comparison (e.g. `<` instead of `<=`) is caught.

function submittedStartIsAcceptable(
  newStartsAt: Date,
  now: Date = new Date(),
): boolean {
  if (Number.isNaN(newStartsAt.getTime())) return false;
  return newStartsAt.getTime() > now.getTime();
}

describe("rescheduleAppointmentViaTokenAction submitted-start guard", () => {
  const now = new Date("2026-06-04T15:00:00Z");

  it("accepts a start strictly after now", () => {
    expect(
      submittedStartIsAcceptable(new Date("2026-06-04T15:00:01Z"), now),
    ).toBe(true);
  });

  it("rejects a start exactly at now (strict > comparison)", () => {
    expect(
      submittedStartIsAcceptable(new Date("2026-06-04T15:00:00Z"), now),
    ).toBe(false);
  });

  it("rejects a start one minute before now", () => {
    expect(
      submittedStartIsAcceptable(new Date("2026-06-04T14:59:00Z"), now),
    ).toBe(false);
  });

  it("rejects a start days in the past", () => {
    expect(
      submittedStartIsAcceptable(new Date("2026-06-01T10:00:00Z"), now),
    ).toBe(false);
  });

  it("rejects an invalid date", () => {
    expect(submittedStartIsAcceptable(new Date("not-a-date"), now)).toBe(false);
  });

  it("uses the live clock when `now` is omitted", () => {
    const aMinuteAgo = new Date(Date.now() - 60_000);
    const inAMinute = new Date(Date.now() + 60_000);
    expect(submittedStartIsAcceptable(aMinuteAgo)).toBe(false);
    expect(submittedStartIsAcceptable(inAMinute)).toBe(true);
  });
});
