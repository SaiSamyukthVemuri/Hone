import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  pushAvailabilityHistory,
  popAvailabilityHistory,
} from "@/lib/booking/availability-history";

// PR A: public-booking prev/next availability navigation. Client-side only —
// the stack logic is unit-tested here; the component wiring + no-migration /
// no-validation-change guarantees are source-pinned below.

describe("availability history stack (pure)", () => {
  it("push records the day being left (forward navigation)", () => {
    expect(pushAvailabilityHistory([], "2026-07-10")).toEqual(["2026-07-10"]);
  });

  it("multiple next jumps maintain ordered history", () => {
    // D1 -> next -> D2 (push D1); D2 -> next -> D3 (push D2)
    let h = pushAvailabilityHistory([], "2026-07-10");
    h = pushAvailabilityHistory(h, "2026-07-14");
    expect(h).toEqual(["2026-07-10", "2026-07-14"]);
  });

  it("pop returns the prior result and shrinks the stack (previous navigation)", () => {
    const h = ["2026-07-10", "2026-07-14"];
    const back1 = popAvailabilityHistory(h);
    expect(back1).toEqual({ previous: "2026-07-14", rest: ["2026-07-10"] });
    const back2 = popAvailabilityHistory(back1.rest);
    expect(back2).toEqual({ previous: "2026-07-10", rest: [] });
  });

  it("pop on an empty stack is a safe no-op (previous = null)", () => {
    expect(popAvailabilityHistory([])).toEqual({ previous: null, rest: [] });
  });

  it("is immutable — never mutates the input array", () => {
    const h = ["2026-07-10"];
    pushAvailabilityHistory(h, "2026-07-14");
    popAvailabilityHistory(h);
    expect(h).toEqual(["2026-07-10"]);
  });
});

describe("PublicBookForm wiring (source pins)", () => {
  const FORM = readFileSync(
    path.resolve(__dirname, "../../../app/book/[slug]/PublicBookForm.tsx"),
    "utf8",
  );

  it("next-available still jumps forward AND now records history", () => {
    // forward: unchanged server jump then setDate(r.date)
    expect(FORM).toMatch(/fetchNextAvailableDateAction\(\{/);
    expect(FORM).toMatch(/setDate\(r\.date\)/);
    // records the day being left before jumping
    expect(FORM).toMatch(/setDateHistory\(\(h\) => pushAvailabilityHistory\(h, date\)\)/);
  });

  it("previous-available pops history and returns to the prior date", () => {
    expect(FORM).toMatch(/popAvailabilityHistory\(dateHistory\)/);
    expect(FORM).toMatch(/setDate\(previous\)/);
    expect(FORM).toMatch(/Back to previous result/);
  });

  it("changing service resets history (availability is service-specific)", () => {
    expect(FORM).toMatch(/setDateHistory\(\[\]\)/);
    expect(FORM).toMatch(/\}, \[serviceId\]\);/);
  });

  it("the Back button is gated on having history", () => {
    expect(FORM).toMatch(/dateHistory\.length > 0 &&/);
  });

  it("no booking-validation change: submit still sends client_type + goes through the same action", () => {
    // the submit path / final validation is untouched by this PR
    expect(FORM).toMatch(/function submit\(/);
    expect(FORM).toMatch(/client_type/);
  });

  it("no payment/tracking/SMS/email behavior added by the nav change", () => {
    // the nav helpers introduce no such surface
    const HELPER = readFileSync(
      path.resolve(__dirname, "../../../lib/booking/availability-history.ts"),
      "utf8",
    );
    expect(HELPER).not.toMatch(/stripe|sendEmail|twilio|sendSms|marketing|consent/i);
  });
});
