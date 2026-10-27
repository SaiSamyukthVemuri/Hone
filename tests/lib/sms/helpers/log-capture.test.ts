import { describe, expect, it } from "vitest";

import { expectMinimumNecessary } from "./log-capture";

// The MSG-007 log check itself. Every success line carries a real-clock ISO
// timestamp, so the phone-suffix scan must ignore the instant's digits (Codex
// 4365831397: a line logged at millisecond .199 matched 604-555-0199) while
// still catching the same digits anywhere else in the line.
const PHONE = "604-555-0199";

function line(fields: Record<string, unknown>): string {
  return JSON.stringify({ event: "sms_sent", smsType: "reminder_24h", ...fields });
}

describe("expectMinimumNecessary: timestamps are not phone digits", () => {
  it.each([
    "2026-10-24T03:17:41.199Z",
    "2026-10-24T03:17:41.0199Z",
    "2026-01-99T01:99:19.199+01:99",
  ])("accepts a line stamped %s", (timestamp) => {
    expect(() => expectMinimumNecessary(line({ timestamp }), { phones: [PHONE] })).not.toThrow();
  });

  it("still catches the suffix outside the timestamp", () => {
    const text = line({ d: "199", timestamp: "2026-10-24T03:17:41.199Z" });
    expect(() => expectMinimumNecessary(text, { phones: [PHONE] })).toThrow(/phone digits/);
  });

  it("still catches a phone-like key beside a timestamp", () => {
    const text = line({ last2: "99", timestamp: "2026-10-24T03:17:41.099Z" });
    expect(() => expectMinimumNecessary(text, { phones: [PHONE] })).toThrow(/phone-like key/);
  });

  it("still catches the full number beside a timestamp", () => {
    const text = line({ n: "6045550199", timestamp: "2026-10-24T03:17:41.000Z" });
    expect(() => expectMinimumNecessary(text, { phones: [PHONE] })).toThrow(/phone digits/);
  });
});
