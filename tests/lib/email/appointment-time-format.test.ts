import { describe, expect, it } from "vitest";
import {
  buildCancellationEmail,
  buildClientConfirmationEmail,
  buildPractitionerNotificationEmail,
} from "@/lib/email/templates/appointment";
import {
  build2hReminderEmail,
  build24hReminderEmail,
} from "@/lib/email/templates/reminders";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";

// PR #157 patch. The reported bug: a confirmation/reminder email for
// an 11:00-12:00 appointment said "11 to 12" (24h) instead of
// "11 AM to 12 PM" / "11:00 AM to 12:00 PM". The fix routes every
// client-facing email through localTimeString12h. These tests build
// real email outputs from the templates and assert the time range +
// single-time formats so a regression that flips one branch back to
// 24h is caught by `npm test`.

// All test fixtures use America/Toronto + a date in EDT (UTC-4)
// so 15:00 UTC = 11:00 AM local, 16:00 UTC = 12:00 PM local. The
// bug spec's literal "11 AM to 12 PM" becomes "11:00 AM to 12:00 PM"
// when minutes happen to be 00.
const TZ = "America/Toronto";
const STARTS_AT = new Date("2026-06-09T15:00:00Z"); // 11:00 AM Toronto
const ENDS_AT = new Date("2026-06-09T16:00:00Z"); // 12:00 PM Toronto

function baseConfirmationFixture() {
  return {
    clientName: "Sarah Wong",
    studioName: "Willow Electrolysis",
    studioAddress: "123 Bloor St W",
    studioEmail: "willow@example.com",
    practitionerName: "Chloe",
    serviceName: "60-minute electrolysis",
    durationMinutes: 60,
    startsAt: STARTS_AT,
    endsAt: ENDS_AT,
    timezone: TZ,
    cancellationUrl: "https://example.com/cancel/abc",
    rescheduleUrl: "https://example.com/reschedule/abc",
    intakeUrl: null,
    preCareInstructions: null,
    treatmentTimeLine: null,
  };
}

describe("client confirmation email renders time range with AM/PM and ' to '", () => {
  it("html body contains '11:00 AM to 12:00 PM'", () => {
    const out = buildClientConfirmationEmail(baseConfirmationFixture());
    expect(out.html).toContain("11:00 AM to 12:00 PM");
  });

  it("text body contains '11:00 AM to 12:00 PM'", () => {
    const out = buildClientConfirmationEmail(baseConfirmationFixture());
    expect(out.text).toContain("11:00 AM to 12:00 PM");
  });

  it("does NOT regress to bare 24h like '11:00 to 12:00'", () => {
    const out = buildClientConfirmationEmail(baseConfirmationFixture());
    expect(out.html).not.toMatch(/\b11:00 to 12:00\b/);
    expect(out.text).not.toMatch(/\b11:00 to 12:00\b/);
  });

  it("does NOT regress to the prior en-dash '11:00 – 12:00'", () => {
    const out = buildClientConfirmationEmail(baseConfirmationFixture());
    expect(out.html).not.toMatch(/11:00 . 12:00/u);
    expect(out.text).not.toMatch(/11:00 . 12:00/u);
  });
});

describe("practitioner notification email also renders with AM/PM", () => {
  it("html + text both contain '11:00 AM to 12:00 PM'", () => {
    const out = buildPractitionerNotificationEmail({
      practitionerName: "Chloe",
      clientName: "Sarah Wong",
      clientEmail: "sarah@example.com",
      clientPhone: "+14165550000",
      studioName: "Willow Electrolysis",
      serviceName: "60-minute electrolysis",
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      timezone: TZ,
      notes: null,
      appointmentUrl: "https://example.com/calendar/abc",
      // PR #163. Practitioner notification gained a referralSourceLabel
      // field; null here keeps the AM/PM assertion focused on time
      // formatting without rendering the new attribution row.
      referralSourceLabel: null,
    });
    expect(out.html).toContain("11:00 AM to 12:00 PM");
    expect(out.text).toContain("11:00 AM to 12:00 PM");
  });
});

describe("cancellation email renders the start time with AM/PM", () => {
  it("html includes '11:00 AM' (single time, not a range)", () => {
    const out = buildCancellationEmail({
      recipientName: "Sarah Wong",
      studioName: "Willow Electrolysis",
      serviceName: "60-minute electrolysis",
      startsAt: STARTS_AT,
      timezone: TZ,
      cancelledBy: "client",
      reason: null,
      isClient: true,
    });
    expect(out.html).toContain("11:00 AM");
    expect(out.text).toContain("11:00 AM");
    // Regression guard: every "11:00" in the body must be followed by
    // " AM" or " PM" (we use a negative lookahead). A leftover 24h
    // "11:00" not followed by AM/PM would be the bug returning.
    expect(out.html).not.toMatch(/11:00(?! ?(AM|PM))/);
    expect(out.text).not.toMatch(/11:00(?! ?(AM|PM))/);
  });
});

describe("24h reminder subject + body render with AM/PM", () => {
  it("subject line contains '11:00 AM'", () => {
    const out = build24hReminderEmail({
      clientName: "Sarah Wong",
      studioName: "Willow Electrolysis",
      studioAddress: null,
      practitionerName: "Chloe",
      serviceName: "60-minute electrolysis",
      durationMinutes: 60,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      timezone: TZ,
      cancellationUrl: "https://example.com/cancel/abc",
      rescheduleUrl: null,
      preCareInstructions: null,
      treatmentTimeLine: null,
    });
    expect(out.subject).toContain("11:00 AM");
    // The body uses the range label.
    expect(out.html).toContain("11:00 AM to 12:00 PM");
    expect(out.text).toContain("11:00 AM to 12:00 PM");
  });

  it("does NOT regress to bare 24h '11:00 to 12:00' in body", () => {
    const out = build24hReminderEmail({
      clientName: "Sarah Wong",
      studioName: "Willow Electrolysis",
      studioAddress: null,
      practitionerName: "Chloe",
      serviceName: "60-minute electrolysis",
      durationMinutes: 60,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      timezone: TZ,
      cancellationUrl: "https://example.com/cancel/abc",
      rescheduleUrl: null,
      preCareInstructions: null,
      treatmentTimeLine: null,
    });
    expect(out.html).not.toMatch(/\b11:00 to 12:00\b/);
    expect(out.text).not.toMatch(/\b11:00 to 12:00\b/);
  });
});

describe("2h reminder subject + body render with AM/PM", () => {
  it("subject line contains '11:00 AM'", () => {
    const out = build2hReminderEmail({
      clientName: "Sarah Wong",
      studioName: "Willow Electrolysis",
      studioAddress: null,
      practitionerName: "Chloe",
      serviceName: "60-minute electrolysis",
      durationMinutes: 60,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      timezone: TZ,
      cancellationUrl: "https://example.com/cancel/abc",
      rescheduleUrl: null,
      preCareInstructions: null,
      treatmentTimeLine: null,
    });
    expect(out.subject).toContain("11:00 AM");
    expect(out.html).toContain("11:00 AM to 12:00 PM");
    expect(out.text).toContain("11:00 AM to 12:00 PM");
  });
});

describe("postcare email greeting renders the appointment time with AM/PM", () => {
  it("html and text bodies include '11:00 AM'", () => {
    const out = buildPostcareEmail({
      clientName: "Sarah Wong",
      studioName: "Willow Electrolysis",
      studioEmail: "willow@example.com",
      practitionerName: "Chloe",
      serviceName: "60-minute electrolysis",
      startsAt: STARTS_AT,
      timezone: TZ,
      aftercareText: "Apply ice for 10 minutes.",
      warningSignsText: null,
      productRecommendationsText: null,
      reviewUrl: null,
      reviewPromptText: null,
    });
    expect(out.html).toContain("11:00 AM");
    expect(out.text).toContain("11:00 AM");
  });
});
