import { describe, expect, it } from "vitest";
import { contestedWindowFailures, type ContestedWindowOutcome } from "../../e2e/hon48-support/contested-window";

// The verdict the five-user booking-versus-repeating-break spec applies to what the database holds afterwards.
// Rule creation and its occurrence reservations are one atomic call, so exactly one of the booking and the break holds the window.

const base: ContestedWindowOutcome = { bookings: 0, rules: 0, occurrenceReservations: 0, overlappingReservations: 0 };

describe("contested window: a booking and a repeating break for the same slot", () => {
  it("the booking wins: one booking, no rule, no occurrence", () => {
    expect(contestedWindowFailures({ ...base, bookings: 1 })).toEqual([]);
  });
  it("the break wins: no booking, one rule with its occurrence reservation", () => {
    expect(contestedWindowFailures({ ...base, rules: 1, occurrenceReservations: 1 })).toEqual([]);
  });
  it("a rule saved WITHOUT its occurrence reservation is a failure, even though the booking committed", () => {
    // The regression a count of bookings + rules could not see: the rule row exists, its reservation does not, and the
    // booking then commits over the window the break was meant to hold.
    const f = contestedWindowFailures({ ...base, bookings: 1, rules: 1, occurrenceReservations: 0 });
    expect(f.length).toBeGreaterThan(0);
    expect(f.join(" ")).toMatch(/occurrence reservation/);
  });
  it("a rule saved without its occurrence reservation and no booking is also a failure", () => {
    expect(contestedWindowFailures({ ...base, rules: 1, occurrenceReservations: 0 }).length).toBeGreaterThan(0);
  });
  it("the window held twice (booking AND break occurrence) is a failure", () => {
    expect(contestedWindowFailures({ ...base, bookings: 1, rules: 1, occurrenceReservations: 1 }).join(" ")).toMatch(/exactly one/);
  });
  it("nobody holding the window (both refused) is a failure", () => {
    expect(contestedWindowFailures(base).join(" ")).toMatch(/exactly one/);
  });
  it("an occurrence reservation with no rule is a failure", () => {
    expect(contestedWindowFailures({ ...base, occurrenceReservations: 1 }).length).toBeGreaterThan(0);
  });
  it("two rules for one submit is a failure", () => {
    expect(contestedWindowFailures({ ...base, rules: 2, occurrenceReservations: 2 }).length).toBeGreaterThan(0);
  });
  it("overlapping reservations are a failure even when the holders are right", () => {
    expect(contestedWindowFailures({ ...base, bookings: 1, overlappingReservations: 1 }).join(" ")).toMatch(/held twice/);
  });
});
