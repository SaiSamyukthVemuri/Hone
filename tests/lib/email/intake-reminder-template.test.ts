import { describe, expect, it } from "vitest";
import { buildIntakeReminderEmail } from "@/lib/email/templates/intake-reminder";

// PR #306. The automated intake-form reminder copy: friendly, mentions the
// appointment date/time, says the form helps the practitioner prepare safely,
// carries the fresh link, and says "ignore if already completed". No PII/date
// in the subject; no medical claims; no delivery/receipt overclaim.

const base = {
  studioName: "Willow Electrolysis",
  intakeUrl: "https://hone.care/intake/eyJhbGciOi.sig",
  startsAt: new Date("2026-07-15T14:00:00.000Z"),
  timezone: "America/Toronto",
};

describe("buildIntakeReminderEmail", () => {
  const email = buildIntakeReminderEmail(base);

  it("subject is generic: no PII, no date, no studio name", () => {
    expect(email.subject).toBe(
      "Reminder: please complete your intake form before your appointment",
    );
    expect(email.subject).not.toMatch(/2026|July|Jul|Willow|\d{1,2}:\d{2}/);
  });

  it("body mentions the appointment date/time (in the studio timezone)", () => {
    // 14:00 UTC on 2026-07-15 = 10:00 AM in America/Toronto (EDT).
    expect(email.text).toMatch(/July 15, 2026/);
    expect(email.text).toMatch(/10:00 ?AM|10:00 AM/);
    expect(email.text).toMatch(/Willow Electrolysis/);
  });

  it("says the form helps the practitioner prepare safely", () => {
    expect(email.text).toMatch(/helps your practitioner prepare safely/i);
  });

  it("includes the fresh secure link", () => {
    expect(email.text).toContain(base.intakeUrl);
    expect(email.html).toContain(base.intakeUrl);
  });

  it("tells the client they can ignore it if already completed", () => {
    expect(email.text).toMatch(/already completed it, you can ignore/i);
    expect(email.html).toMatch(/already completed it, you can ignore/i);
  });

  it("makes no medical claims and no delivery/receipt overclaim", () => {
    const all = `${email.subject}\n${email.text}\n${email.html}`;
    expect(all).not.toMatch(/\b(medical|diagnos|treatment plan|prescri)/i);
    expect(all).not.toMatch(/\b(delivered|received|opened)\b/i);
  });

  it("falls back gracefully on a blank studio name", () => {
    const e = buildIntakeReminderEmail({ ...base, studioName: "   " });
    expect(e.text).toMatch(/Your studio/);
  });
});
