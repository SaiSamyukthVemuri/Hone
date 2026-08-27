import { describe, expect, it } from "vitest";

import {
  summarizeCalendar,
  unreadableCalendar,
  type CensusRow,
} from "@/lib/finance/financial-briefing-model";

const rows = (...statuses: string[]): CensusRow[] => statuses.map((status) => ({ status }));

describe("summarizeCalendar — the period's appointments, by status", () => {
  it("counts the four statuses and totals them as booked", () => {
    const c = summarizeCalendar(
      rows("completed", "completed", "cancelled", "no_show", "confirmed", "completed"),
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
    const c = summarizeCalendar([]);
    for (const fact of [c.booked, c.completed, c.cancelled, c.noShow, c.stillToHappen]) {
      expect(fact).toEqual({ known: true, value: 0 });
    }
    expect(c.partition.closed).toBe(true);
  });

  it("the four parts account for every booking, and the claim says so", () => {
    const c = summarizeCalendar(rows("completed", "cancelled", "no_show", "confirmed"));
    expect(c.partition.closed).toBe(true);
    expect(c.partition.unrecognisedStatuses).toEqual([]);
    if (c.booked.known && c.completed.known && c.cancelled.known && c.noShow.known && c.stillToHappen.known) {
      expect(
        c.completed.value + c.cancelled.value + c.noShow.value + c.stillToHappen.value,
      ).toBe(c.booked.value);
    }
  });

  it("AN UNRECOGNISED STATUS IS DETECTED, NOT DROPPED — the counts stay true and the claim is withdrawn", () => {
    // Dropping the row would leave four correct-looking counts that no longer
    // account for what was booked, and the screen would print "balanced".
    const c = summarizeCalendar(rows("completed", "rescheduled", "confirmed"));
    expect(c.booked).toEqual({ known: true, value: 3 });
    expect(c.completed).toEqual({ known: true, value: 1 });
    expect(c.partition.closed).toBe(false);
    expect(c.partition.unrecognisedStatuses).toEqual(["rescheduled"]);
  });

  it("reports each unrecognised status once, sorted, however often it appears", () => {
    const c = summarizeCalendar(rows("zeta", "alpha", "zeta", "completed"));
    expect(c.partition.unrecognisedStatuses).toEqual(["alpha", "zeta"]);
  });
});

describe("unreadableCalendar — an absence never becomes a partial answer", () => {
  it("A FAILED READ IS NOT A ZERO on any line", () => {
    const c = unreadableCalendar("unavailable");
    for (const fact of [c.booked, c.completed, c.cancelled, c.noShow, c.stillToHappen]) {
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
