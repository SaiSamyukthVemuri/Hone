import { describe, expect, it } from "vitest";
import {
  INTAKE_CTA_LABEL,
  INTAKE_SECTION_COPY,
  INTAKE_STANDALONE_SUBJECT,
  buildIntakeReminderEmail,
  type IntakeReminderKind,
} from "@/lib/email/templates/intake-reminder";

// The STANDALONE intake reminder: what the ~24h / ~2h window sends when the
// studio has that appointment reminder OFF but intake reminders ON. Copy is
// operator-ruled and shared with the composed section rendered inside the
// appointment reminder, so the two can never drift.

const base = {
  studioName: "Willow Electrolysis",
  intakeUrl: "https://hone.care/intake/eyJhbGciOi.sig",
  startsAt: new Date("2026-07-15T14:00:00.000Z"),
  timezone: "America/Toronto",
};

const KINDS: IntakeReminderKind[] = ["24h", "2h"];

// The templates HTML-escape their copy, so the 2h body's apostrophe reaches
// the markup as &#39;. Assert against the same escaping the template applies.
const htmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");


describe("standalone intake reminder subjects", () => {
  it("uses the ruled neutral subjects", () => {
    expect(INTAKE_STANDALONE_SUBJECT["24h"]).toBe(
      "Please complete your intake form",
    );
    expect(INTAKE_STANDALONE_SUBJECT["2h"]).toBe(
      "A quick reminder about your intake form",
    );
  });

  it("NEVER exposes completion state in the subject", () => {
    // A subject shows on a lock screen and is asserted at send time, so it
    // must stay true even if the client submits during the send race.
    for (const kind of KINDS) {
      const s = buildIntakeReminderEmail({ ...base, kind }).subject;
      expect(s).not.toMatch(/still incomplete|incomplete|not completed|missing/i);
    }
  });

  it("carries no PII, no date and no studio name in the subject", () => {
    for (const kind of KINDS) {
      const s = buildIntakeReminderEmail({ ...base, kind }).subject;
      expect(s).not.toMatch(/2026|July|Jul|Willow|\d{1,2}:\d{2}/);
    }
  });
});

describe.each(KINDS)("buildIntakeReminderEmail (%s)", (kind) => {
  const email = buildIntakeReminderEmail({ ...base, kind });

  it("leads with the ruled heading and body for this window", () => {
    const { heading, body } = INTAKE_SECTION_COPY[kind];
    expect(email.text).toContain(heading);
    expect(email.html).toContain(htmlEscape(heading));
    expect(email.text).toContain(body);
    expect(email.html).toContain(htmlEscape(body));
  });

  it("identifies the studio and the appointment date/time in its timezone", () => {
    // 14:00 UTC on 2026-07-15 = 10:00 AM in America/Toronto (EDT).
    expect(email.text).toMatch(/July 15, 2026/);
    expect(email.text).toMatch(/10:00 ?AM/);
    expect(email.text).toMatch(/Willow Electrolysis/);
  });

  it("carries the fresh secure link behind the ruled CTA label", () => {
    expect(INTAKE_CTA_LABEL).toBe("Complete intake form");
    expect(email.text).toContain(base.intakeUrl);
    expect(email.html).toContain(base.intakeUrl);
    expect(email.text).toContain(INTAKE_CTA_LABEL);
    expect(email.html).toContain(INTAKE_CTA_LABEL);
  });

  it("keeps the ignore-if-done escape hatch, so it stays true under a submit race", () => {
    expect(email.text).toMatch(/already completed it, you can ignore/i);
    expect(email.html).toMatch(/already completed it, you can ignore/i);
  });

  it("makes no medical claim and no delivery/receipt overclaim", () => {
    const all = `${email.subject}\n${email.text}\n${email.html}`;
    expect(all).not.toMatch(/\b(medical|diagnos|treatment plan|prescri)/i);
    expect(all).not.toMatch(/\b(delivered|received|opened)\b/i);
  });

  it("does not shame the client", () => {
    const all = `${email.subject}\n${email.text}`;
    expect(all).not.toMatch(/\b(still incomplete|failed to|you have not|overdue|urgent)\b/i);
  });

  it("falls back gracefully on a blank studio name", () => {
    const e = buildIntakeReminderEmail({ ...base, kind, studioName: "   " });
    expect(e.text).toMatch(/Your studio/);
  });
});

describe("the ruled copy itself", () => {
  it("is exactly what the operator specified for each window", () => {
    expect(INTAKE_SECTION_COPY["24h"]).toEqual({
      heading: "Please complete your intake form",
      body: "We still need your intake form before your appointment. Completing it ahead of time helps your practitioner prepare.",
    });
    expect(INTAKE_SECTION_COPY["2h"]).toEqual({
      heading: "Quick reminder about your intake form",
      body: "If you haven't already, please complete your intake form before your appointment.",
    });
  });
});
