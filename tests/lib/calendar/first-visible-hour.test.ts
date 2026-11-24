import { describe, expect, it } from "vitest";
import { firstVisibleHour } from "@/app/(app)/calendar/first-visible-hour";

const day = {
  availability: { isOpen: true, openTime: "11:30:00" },
  appts: [],
  timedBlocks: [],
  recurringBreaks: [],
};
const timezone = "America/Toronto";

describe("initial calendar scroll", () => {
  it("opens at the earliest working hour across columns", () => {
    expect(firstVisibleHour([day, { ...day, availability: { isOpen: true, openTime: "09:15" } }], timezone)).toBe(9);
  });

  it("includes an early appointment in the studio timezone even on a closed day", () => {
    expect(firstVisibleHour([day, {
      ...day,
      availability: { isOpen: false, openTime: null },
      appts: [{ starts_at: "2026-11-23T12:30:00Z" }],
    }], timezone)).toBe(7);
  });

  it("keeps the full grid when working hours are unknown", () => {
    expect(firstVisibleHour([{ ...day, availability: null }], timezone)).toBe(6);
  });
});
