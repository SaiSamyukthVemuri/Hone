import { describe, expect, it } from "vitest";

import {
  summarizeCalendar,
  unreadableCalendar,
  type CensusRow,
} from "@/lib/finance/financial-briefing-model";

/**
 * A FIXED reference instant. Nothing in these tests reads the clock, so the tie
 * rule and both sides of the split are pinned rather than sampled.
 */
const NOW = new Date("2026-08-27T12:00:00.000Z");
const AN_HOUR_BEFORE = "2026-08-27T11:00:00.000Z";
const AN_HOUR_AFTER = "2026-08-27T13:00:00.000Z";
const EXACTLY_NOW = "2026-08-27T12:00:00.000Z";

/**
 * Status-only rows, every one starting in the FUTURE.
 *
 * Deliberate: it keeps every pre-existing expectation about `stillToHappen`
 * meaning what it meant before the temporal split, so those tests still assert
 * the thing they were written to assert.
 */
const rows = (...statuses: string[]): CensusRow[] =>
  statuses.map((status) => ({ status, starts_at: AN_HOUR_AFTER }));

/** One row, placed in time explicitly. */
const at = (status: string, starts_at: string): CensusRow => ({ status, starts_at });

describe("summarizeCalendar — the period's appointments, by status", () => {
  it("counts the four statuses and totals them as booked", () => {
    const c = summarizeCalendar(
      rows("completed", "completed", "cancelled", "no_show", "confirmed", "completed"),
      NOW,
    );
    expect(c.booked).toEqual({ known: true, value: 6 });
    expect(c.completed).toEqual({ known: true, value: 3 });
    expect(c.cancelled).toEqual({ known: true, value: 1 });
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.stillToHappen).toEqual({ known: true, value: 1 });
  });

  it("AN EMPTY PERIOD IS A KNOWN ZERO, because the read succeeded", () => {
    // This is the ONLY route by which a zero reaches this screen. A studio with
    // a quiet week genuinely had nothing, and saying so is not the same as
    // failing to find out.
    const c = summarizeCalendar([], NOW);
    for (const fact of [c.booked, c.completed, c.cancelled, c.noShow, c.stillToHappen, c.pastConfirmed]) {
      expect(fact).toEqual({ known: true, value: 0 });
    }
    expect(c.partition.closed).toBe(true);
  });

  it("the five parts account for every booking, and the claim says so", () => {
    const c = summarizeCalendar(rows("completed", "cancelled", "no_show", "confirmed"), NOW);
    expect(c.partition.closed).toBe(true);
    expect(c.partition.unrecognisedStatuses).toEqual([]);
    if (
      c.booked.known && c.completed.known && c.cancelled.known &&
      c.noShow.known && c.stillToHappen.known && c.pastConfirmed.known
    ) {
      expect(
        c.completed.value + c.cancelled.value + c.noShow.value +
          c.stillToHappen.value + c.pastConfirmed.value,
      ).toBe(c.booked.value);
    }
  });

  it("AN UNRECOGNISED STATUS IS DETECTED, NOT DROPPED — the counts stay true and the claim is withdrawn", () => {
    // Dropping the row would leave four correct-looking counts that no longer
    // account for what was booked, and the screen would print "balanced".
    const c = summarizeCalendar(rows("completed", "rescheduled", "confirmed"), NOW);
    expect(c.booked).toEqual({ known: true, value: 3 });
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.partition.closed).toBe(false);
    expect(c.partition.unrecognisedStatuses).toEqual(["rescheduled"]);
  });

  it("reports each unrecognised status once, sorted, however often it appears", () => {
    const c = summarizeCalendar(rows("zeta", "alpha", "zeta", "completed"), NOW);
    expect(c.partition.unrecognisedStatuses).toEqual(["alpha", "zeta"]);
  });
});

describe("STILL TO HAPPEN is a claim about TIME, not only about status", () => {
  // Why this exists: `confirmed` says "not closed out either way". Nothing
  // writes a terminal status when an appointment elapses, so read as "still to
  // happen" a stale row reports a visit as upcoming forever. Measured on
  // production 2026-08-27: 29 of Willow's appointments were past and still
  // confirmed, the oldest from 2026-05-17.

  it("A — a FUTURE confirmed appointment is still to happen", () => {
    const c = summarizeCalendar([at("confirmed", AN_HOUR_AFTER)], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("B — a PAST confirmed appointment is NOT still to happen", () => {
    const c = summarizeCalendar([at("confirmed", AN_HOUR_BEFORE)], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 1 });
    // ...and it is not reinterpreted as an outcome. The row says the record was
    // never closed out; it is not evidence the visit happened or was missed.
    expect(c.completed).toEqual({ known: true, value: 0 });
    expect(c.noShow).toEqual({ known: true, value: 0 });
    expect(c.cancelled).toEqual({ known: true, value: 0 });
    // Still counted. A past-confirmed row is never dropped from the total.
    expect(c.booked).toEqual({ known: true, value: 1 });
  });

  it("C — THE TIE: starting exactly at the reference instant is STILL TO HAPPEN", () => {
    // Pinned deliberately. `>=` opens the interval, matching the half-open
    // [start, end) convention the period window already uses, and an
    // appointment starting exactly now has not yet passed.
    const c = summarizeCalendar([at("confirmed", EXACTLY_NOW)], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("D — a past COMPLETED appointment counts as completed only", () => {
    const c = summarizeCalendar([at("completed", AN_HOUR_BEFORE)], NOW);
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
  });

  it("E — a FUTURE cancelled appointment is cancelled, never still to happen", () => {
    const c = summarizeCalendar([at("cancelled", AN_HOUR_AFTER)], NOW);
    expect(c.cancelled).toEqual({ known: true, value: 1 });
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("F — a past NO-SHOW counts as no-show only", () => {
    const c = summarizeCalendar([at("no_show", AN_HOUR_BEFORE)], NOW);
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
  });

  it("G — MIXED CENSUS: every row is accounted for exactly once", () => {
    const c = summarizeCalendar(
      [
        at("confirmed", AN_HOUR_AFTER),
        at("confirmed", AN_HOUR_AFTER),
        at("confirmed", EXACTLY_NOW),
        at("confirmed", AN_HOUR_BEFORE),
        at("completed", AN_HOUR_BEFORE),
        at("completed", AN_HOUR_BEFORE),
        at("cancelled", AN_HOUR_AFTER),
        at("no_show", AN_HOUR_BEFORE),
      ],
      NOW,
    );
    expect(c.stillToHappen).toEqual({ known: true, value: 3 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 1 });
    expect(c.completed).toEqual({ known: true, value: 2 });
    expect(c.cancelled).toEqual({ known: true, value: 1 });
    expect(c.noShow).toEqual({ known: true, value: 1 });
    expect(c.booked).toEqual({ known: true, value: 8 });
    expect(c.partition.closed).toBe(true);
    expect(c.partition.undatableConfirmed).toBe(0);
    if (
      c.booked.known && c.completed.known && c.cancelled.known &&
      c.noShow.known && c.stillToHappen.known && c.pastConfirmed.known
    ) {
      expect(
        c.stillToHappen.value + c.pastConfirmed.value + c.completed.value +
          c.cancelled.value + c.noShow.value,
      ).toBe(c.booked.value);
    }
  });

  it("AN UNREADABLE START IS NOT SILENTLY 'PAST' — it withdraws the claim", () => {
    // `Date.parse("nonsense")` is NaN and `NaN >= reference` is false, so an
    // unguarded comparison would have filed every unreadable start under PAST:
    // a wrong answer wearing the shape of a decision. Neither bucket is
    // established, so neither is credited and the completeness claim goes.
    const c = summarizeCalendar([at("confirmed", "not-a-timestamp")], NOW);
    expect(c.stillToHappen).toEqual({ known: true, value: 0 });
    expect(c.pastConfirmed).toEqual({ known: true, value: 0 });
    expect(c.partition.undatableConfirmed).toBe(1);
    expect(c.partition.closed).toBe(false);
    // The row is still counted in the total, and its status is still true.
    expect(c.booked).toEqual({ known: true, value: 1 });
    expect(c.partition.unrecognisedStatuses).toEqual([]);
  });

  it("an unreadable start on a NON-confirmed row changes nothing", () => {
    // Only `confirmed` is split on time, so only `confirmed` can be undatable.
    const c = summarizeCalendar([at("completed", "not-a-timestamp")], NOW);
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.partition.undatableConfirmed).toBe(0);
    expect(c.partition.closed).toBe(true);
  });
});

describe("unreadableCalendar — an absence never becomes a partial answer", () => {
  it("A FAILED READ IS NOT A ZERO on any line", () => {
    const c = unreadableCalendar("unavailable");
    for (const fact of [c.booked, c.completed, c.cancelled, c.noShow, c.stillToHappen, c.pastConfirmed]) {
      expect(fact.known).toBe(false);
      expect(fact).not.toHaveProperty("value");
      if (!fact.known) expect(fact.cause).toBe("unavailable");
    }
  });

  it("A TRUNCATED READ IS NOT A TOTAL, and carries its own distinct cause", () => {
    const c = unreadableCalendar("not_enumerable");
    expect(c.booked.known).toBe(false);
    if (!c.booked.known) expect(c.booked.cause).toBe("not_enumerable");
  });

  it("refuses the partition claim, because there is nothing to claim balance over", () => {
    expect(unreadableCalendar("unavailable").partition.closed).toBe(false);
    expect(unreadableCalendar("not_enumerable").partition.closed).toBe(false);
  });

  it("does not publish the statuses that happened to arrive before the failure", () => {
    // A partial census is how a confident, understated screen reaches an owner.
    expect(unreadableCalendar("unavailable").partition.unrecognisedStatuses).toEqual([]);
  });
});
