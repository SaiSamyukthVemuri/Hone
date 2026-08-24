import { describe, expect, it } from "vitest";
import { build24hReminderSms, build2hReminderSms } from "@/lib/sms/templates";

// The intake CTA COMPOSED INTO the appointment reminder SMS. One SMS per
// appointment per window: the existing claim_sms_send slot owns the window,
// and there is deliberately no standalone intake SMS - if the window's SMS
// toggle is off, no intake SMS is sent at all.
//
// PURE builder tests: strings only, no Twilio, no network, no DB.

const START = new Date("2026-06-03T18:30:00Z"); // 2:30 PM America/Toronto
const TZ = "America/Toronto";
const INTAKE_URL = "https://hone.care/intake/eyJhbGciOi.sig";
const MANAGE_URL = "https://hone.care/manage/tok";

const BUILDERS = [
  { kind: "24h" as const, build: build24hReminderSms },
  { kind: "2h" as const, build: build2hReminderSms },
];

const base = {
  studioName: "Willow",
  startsAt: START,
  timezone: TZ,
  manageUrl: MANAGE_URL,
};

describe.each(BUILDERS)("$kind reminder SMS without an intake link", ({ build }) => {
  it("renders no intake wording and no intake link", () => {
    for (const body of [build({ ...base }), build({ ...base, intakeUrl: null })]) {
      expect(body).not.toMatch(/intake/i);
      expect(body).not.toContain("/intake/");
    }
  });

  it("is byte-identical whether intakeUrl is absent or explicitly null", () => {
    expect(build({ ...base, intakeUrl: null })).toBe(build({ ...base }));
  });
});

describe.each(BUILDERS)("$kind reminder SMS WITH an intake link", ({ kind, build }) => {
  const plain = build({ ...base });
  const body = build({ ...base, intakeUrl: INTAKE_URL });

  it("carries a concise intake CTA and the secure link", () => {
    expect(body).toContain("complete your intake form");
    expect(body).toContain(INTAKE_URL);
  });

  it("uses this window's ruled wording", () => {
    if (kind === "24h") {
      expect(body).toContain(
        "Please complete your intake form before your visit:",
      );
    } else {
      expect(body).toContain(
        "If you haven't already, please complete your intake form:",
      );
    }
  });

  it("ADDS to the appointment reminder rather than replacing it", () => {
    // The studio, the moment and the manage link all survive.
    expect(body).toContain("Willow");
    expect(body).toContain("2:30 PM");
    expect(body).toContain(MANAGE_URL);
    expect(body.length).toBeGreaterThan(plain.length);
  });

  it("stays ONE message: a single body, not an appointment SMS plus an intake SMS", () => {
    // One head, one intake phrase, one manage phrase, one disclosure.
    expect(body.match(/complete your intake form/g) ?? []).toHaveLength(1);
    expect(body.match(/Manage appointment:/g) ?? []).toHaveLength(1);
    expect(
      body.match(/Do not reply here except STOP to opt out\./g) ?? [],
    ).toHaveLength(1);
  });

  it("NEVER states completion state and carries no clinical or health detail", () => {
    // Lock-screen neutral: it asks for the form, it does not report on it.
    expect(body).not.toMatch(/incomplete|not completed|still need|missing|overdue/i);
    expect(body).not.toMatch(/\b(medical|health|diagnos|condition|medication|treatment plan)\b/i);
  });

  it("keeps the STOP disclosure last, per the shipped SMS contract", () => {
    expect(body.trimEnd().endsWith("Do not reply here except STOP to opt out.")).toBe(
      true,
    );
  });

  it("follows the existing studio-safe part convention", () => {
    // {Studio}: <event>. <intake>. <manage>. <disclosure> - the same shape the
    // booking-confirmation SMS has always used.
    const intakeAt = body.indexOf("complete your intake form");
    const manageAt = body.indexOf("Manage appointment:");
    expect(intakeAt).toBeGreaterThan(-1);
    expect(manageAt).toBeGreaterThan(intakeAt);
  });
});
