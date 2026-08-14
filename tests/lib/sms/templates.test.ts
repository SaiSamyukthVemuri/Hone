import { describe, expect, it } from "vitest";
import {
  buildBookingConfirmationSms,
  build24hReminderSms,
  build2hReminderSms,
} from "@/lib/sms/templates";

// Client-facing SMS must render 12-hour time (e.g. "2:30 PM"), never 24-hour
// ("14:30"). These are PURE builder unit tests, they format strings only and
// never touch Twilio / the network / the DB, so no SMS is sent. Timezone
// correctness is preserved: the same UTC instant renders differently per tz.

// 2026-06-03T18:30:00Z → 2:30 PM in America/Toronto (EDT, UTC-4),
// 11:30 AM in America/Vancouver (PDT, UTC-7).
const AFTERNOON = new Date("2026-06-03T18:30:00Z");
const TORONTO = "America/Toronto";
const VANCOUVER = "America/Vancouver";

// Any bare 24-hour hour (13–23) followed by :MM, i.e. military time with no
// AM/PM. Client-facing SMS must never contain this.
const MILITARY = /\b(1[3-9]|2[0-3]):[0-5]\d\b/;
const TWELVE_HOUR = /\b\d{1,2}:[0-5]\d\s?(AM|PM)\b/;

const conf = (tz: string, startsAt = AFTERNOON) =>
  buildBookingConfirmationSms({
    studioName: "Willow",
    startsAt,
    timezone: tz,
    intakeUrl: null,
    manageUrl: "https://hone.care/manage/tok",
  });
const r24 = (tz: string, startsAt = AFTERNOON) =>
  build24hReminderSms({ studioName: "Willow", startsAt, timezone: tz, manageUrl: null });
const r2 = (tz: string, startsAt = AFTERNOON) =>
  build2hReminderSms({ studioName: "Willow", startsAt, timezone: tz, manageUrl: null });

describe("SMS templates render 12-hour (not military) time", () => {
  it("confirmation SMS uses 12-hour time", () => {
    const body = conf(TORONTO);
    expect(body).toContain("2:30 PM");
    expect(body).toMatch(TWELVE_HOUR);
    expect(body).not.toMatch(MILITARY);
  });
  it("24h reminder SMS uses 12-hour time", () => {
    const body = r24(TORONTO);
    expect(body).toContain("2:30 PM");
    expect(body).toMatch(TWELVE_HOUR);
    expect(body).not.toMatch(MILITARY);
  });
  it("2h reminder SMS uses 12-hour time", () => {
    const body = r2(TORONTO);
    expect(body).toContain("2:30 PM");
    expect(body).toMatch(TWELVE_HOUR);
    expect(body).not.toMatch(MILITARY);
  });

  it("NO SMS template renders 24-hour time across afternoon/evening hours", () => {
    // Every hour 13:00–23:30 local would print as 13:00…23:30 under the old
    // 24h formatter. Assert each builder stays 12-hour for all of them.
    for (let h = 13; h <= 23; h++) {
      const startsAt = new Date(`2026-06-03T${String(h).padStart(2, "0")}:30:00Z`);
      // Use UTC so the hour maps predictably; UTC is a valid IANA-ish tz here.
      for (const body of [conf("UTC", startsAt), r24("UTC", startsAt), r2("UTC", startsAt)]) {
        expect(body).not.toMatch(MILITARY);
        expect(body).toMatch(TWELVE_HOUR);
      }
    }
  });
});

describe("timezone behavior is preserved (only the display format changed)", () => {
  it("the same instant renders in the correct local 12-hour time per timezone", () => {
    expect(conf(TORONTO)).toContain("2:30 PM");
    expect(conf(VANCOUVER)).toContain("11:30 AM"); // UTC-7, same instant
  });
  it("the displayed DATE follows the timezone, not naive UTC", () => {
    // 2026-06-04T01:00:00Z is still June 3, 9:00 PM in Toronto (UTC-4).
    const lateNight = new Date("2026-06-04T01:00:00Z");
    const body = conf(TORONTO, lateNight);
    expect(body).toContain("June 3");
    expect(body).toContain("9:00 PM");
    expect(body).not.toContain("June 4");
  });
  it("the year is omitted from the moment phrase", () => {
    expect(conf(TORONTO)).not.toContain("2026");
  });
});
