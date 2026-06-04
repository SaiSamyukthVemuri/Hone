import { describe, expect, it } from "vitest";
import { filterFutureSlots, type Slot } from "@/lib/booking/slots";

// PR #149: the shared past-time filter for public booking + public
// reschedule slot lists. The tests below pin down the contract so
// the two public surfaces cannot silently drift apart again.

function makeSlot(iso: string): Slot {
  return {
    start: iso,
    end: new Date(new Date(iso).getTime() + 30 * 60_000).toISOString(),
    startLabel: iso,
  };
}

describe("filterFutureSlots", () => {
  const now = new Date("2026-06-04T15:00:00Z");

  it("drops slots whose start is strictly before now", () => {
    const slots = [
      makeSlot("2026-06-04T14:00:00Z"),
      makeSlot("2026-06-04T14:59:59Z"),
      makeSlot("2026-06-04T16:00:00Z"),
    ];
    const out = filterFutureSlots(slots, now);
    expect(out.map((s) => s.start)).toEqual(["2026-06-04T16:00:00Z"]);
  });

  it("drops the slot that starts EXACTLY at now (strict >)", () => {
    const slots = [
      makeSlot("2026-06-04T15:00:00Z"), // == now
      makeSlot("2026-06-04T15:00:01Z"), // 1 second after now
    ];
    const out = filterFutureSlots(slots, now);
    expect(out.map((s) => s.start)).toEqual(["2026-06-04T15:00:01Z"]);
  });

  it("keeps every slot when all are in the future", () => {
    const slots = [
      makeSlot("2026-06-04T15:01:00Z"),
      makeSlot("2026-06-04T18:30:00Z"),
      makeSlot("2026-06-05T09:00:00Z"),
    ];
    const out = filterFutureSlots(slots, now);
    expect(out.length).toBe(3);
  });

  it("returns an empty array when every slot is in the past", () => {
    const slots = [
      makeSlot("2026-06-04T10:00:00Z"),
      makeSlot("2026-06-04T11:30:00Z"),
    ];
    const out = filterFutureSlots(slots, now);
    expect(out).toEqual([]);
  });

  it("returns an empty array when the input is empty", () => {
    expect(filterFutureSlots([], now)).toEqual([]);
  });

  it("defaults `now` to the current clock when omitted", () => {
    // A slot that started one minute ago must always be dropped, no
    // matter when the test runs.
    const aMinuteAgo = new Date(Date.now() - 60_000).toISOString();
    const inThreeMinutes = new Date(Date.now() + 3 * 60_000).toISOString();
    const out = filterFutureSlots([makeSlot(aMinuteAgo), makeSlot(inThreeMinutes)]);
    expect(out.map((s) => s.start)).toEqual([inThreeMinutes]);
  });
});
