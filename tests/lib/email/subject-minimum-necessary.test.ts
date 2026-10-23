import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCancellationEmail,
  buildClientConfirmationEmail,
  buildPractitionerNotificationEmail,
} from "@/lib/email/templates/appointment";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";
import {
  build24hReminderEmail,
  build2hReminderEmail,
  buildNoShowFollowupEmail,
} from "@/lib/email/templates/reminders";

// HIPAA-READY-01 (issue #828), SUBJECT RULE. A subject persists in the inbox,
// shows on a lock screen and is stored by the email provider, so it never
// carries the client's name, the service, or the appointment date or time.
// The studio name is allowed: the From line already shows it.
// Every value below is synthetic and deliberately distinctive, so any leak is
// visible as a substring.

const CLIENT = "Zephyrine Synthetic-Client";
const SERVICE = "Synthetic Upper Lip Electrolysis";
const STUDIO = "Synthetic Studio";
const TZ = "America/Toronto";
// 2031-03-04 15:45 Toronto. Unusual minute, so the time cannot hide in copy.
const START = new Date("2031-03-04T20:45:00Z");
const END = new Date("2031-03-04T21:30:00Z");

const DATE_TIME_PATTERNS: RegExp[] = [
  /\b\d{1,2}:\d{2}\b/, // any clock time
  /\b(AM|PM)\b/i,
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  /\b(today|tomorrow|tonight)\b/i,
  /\b2031\b/,
];

function assertMinimal(subject: string) {
  expect(subject).not.toContain(CLIENT);
  expect(subject).not.toMatch(/Zephyrine/);
  expect(subject).not.toContain(SERVICE);
  expect(subject).not.toMatch(/Electrolysis|Upper Lip/i);
  for (const re of DATE_TIME_PATTERNS) expect(subject).not.toMatch(re);
}

const reminderProps = {
  clientName: CLIENT,
  studioName: STUDIO,
  studioAddress: null,
  practitionerName: "Synthetic Practitioner",
  serviceName: SERVICE,
  durationMinutes: 45,
  startsAt: START,
  endsAt: END,
  timezone: TZ,
  cancellationUrl: "https://hone.care/cancel/tok_SYNTH",
  rescheduleUrl: null,
  preCareInstructions: null,
  treatmentTimeLine: null,
};

const cases: Array<[string, () => { subject: string; text: string }]> = [
  [
    "client confirmation",
    () =>
      buildClientConfirmationEmail({
        ...reminderProps,
        studioEmail: "studio@synthetic.invalid",
        intakeUrl: null,
      }),
  ],
  [
    "practitioner new-booking notification",
    () =>
      buildPractitionerNotificationEmail({
        practitionerName: "Synthetic Practitioner",
        clientName: CLIENT,
        clientEmail: "client@synthetic.invalid",
        clientPhone: null,
        studioName: STUDIO,
        serviceName: SERVICE,
        startsAt: START,
        endsAt: END,
        timezone: TZ,
        notes: null,
        appointmentUrl: "https://hone.care/calendar/x",
        referralSourceLabel: null,
        bookingReference: "K3M9QX",
      }),
  ],
  [
    "cancellation (client recipient)",
    () =>
      buildCancellationEmail({
        recipientName: CLIENT,
        clientName: CLIENT,
        studioName: STUDIO,
        serviceName: SERVICE,
        durationMinutes: 45,
        startsAt: START,
        timezone: TZ,
        actorName: null,
        actorRole: "practitioner",
        reason: null,
        isClient: true,
      }),
  ],
  [
    "cancellation (practitioner recipient)",
    () =>
      buildCancellationEmail({
        recipientName: "Synthetic Practitioner",
        clientName: CLIENT,
        studioName: STUDIO,
        serviceName: SERVICE,
        durationMinutes: 45,
        startsAt: START,
        timezone: TZ,
        actorName: CLIENT,
        actorRole: "client",
        reason: null,
        isClient: false,
      }),
  ],
  ["24h reminder", () => build24hReminderEmail(reminderProps)],
  ["2h reminder", () => build2hReminderEmail(reminderProps)],
];

// Builders whose body carries no service: checked for the subject rule only.
const subjectOnlyCases: Array<[string, () => { subject: string }]> = [
  [
    "no-show follow-up (Codex P1 on #859: 'We missed you today')",
    () =>
      buildNoShowFollowupEmail({
        clientName: CLIENT,
        studioName: STUDIO,
        rebookUrl: null,
      }),
  ],
  [
    "postcare ('Aftercare for your appointment' revealed a treatment)",
    () =>
      buildPostcareEmail({
        clientName: CLIENT,
        studioName: STUDIO,
        studioEmail: null,
        practitionerName: null,
        serviceName: SERVICE,
        startsAt: START,
        timezone: TZ,
        aftercareText: "Synthetic aftercare text.",
        warningSignsText: null,
        productRecommendationsText: null,
        reviewUrl: null,
      }),
  ],
];

describe("email subjects carry no client name, service, date or time", () => {
  it.each(cases)("%s", (_label, build) => {
    const email = build();
    assertMinimal(email.subject);
    // The body still carries what the recipient needs.
    expect(email.text).toContain(SERVICE);
  });

  it.each(subjectOnlyCases)("%s", (_label, build) => {
    assertMinimal(build().subject);
  });

  it("the studio name stays in the subject (the From line already shows it)", () => {
    for (const [, build] of [...cases, ...subjectOnlyCases]) {
      expect(build().subject).toContain(STUDIO);
    }
  });
});

describe("move notification subjects (source)", () => {
  it("never interpolate the service, date or time", () => {
    const src = readFileSync(
      path.resolve(__dirname, "../../../lib/email/notify-appointment-moved.ts"),
      "utf8",
    );
    const subjects = [...src.matchAll(/subject = `([^`]*)`/g)].map((m) => m[1]);
    expect(subjects.length).toBeGreaterThanOrEqual(3);
    for (const s of subjects) {
      expect(s).not.toMatch(/serviceName|dateStr|timeStr|clientName/);
    }
  });
});

// THREADING (Codex P1 4354990813 / 4354990818 on #1049). Gmail and Outlook
// thread on the normalized subject plus participants (the problem PR #127
// fixed for the magic link). Minimum-necessary subjects must not collapse
// DIFFERENT messages into one thread, so each must keep a non-sensitive
// distinction. Normalization here is what the clients do: drop reply/forward
// prefixes, fold case and whitespace.
function normalizedSubject(subject: string): string {
  return subject.replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();
}

const practitionerNotice = (bookingReference: string) =>
  buildPractitionerNotificationEmail({
    practitionerName: "Synthetic Practitioner",
    clientName: CLIENT,
    clientEmail: "client@synthetic.invalid",
    clientPhone: null,
    studioName: STUDIO,
    serviceName: SERVICE,
    startsAt: START,
    endsAt: END,
    timezone: TZ,
    notes: null,
    appointmentUrl: "https://hone.care/calendar/x",
    referralSourceLabel: null,
    bookingReference,
  });

describe("subjects keep unrelated messages out of one thread", () => {
  it("two different bookings' practitioner notices have different normalized subjects", () => {
    const a = practitionerNotice("K3M9QX").subject;
    const b = practitionerNotice("P7R2TD").subject;
    expect(normalizedSubject(a)).not.toBe(normalizedSubject(b));
    assertMinimal(a);
    assertMinimal(b);
  });

  it("the same booking renders the same subject (a retry does not fork a thread)", () => {
    expect(practitionerNotice("K3M9QX").subject).toBe(practitionerNotice("K3M9QX").subject);
  });

  it("the 24-hour and 2-hour reminders have different normalized subjects", () => {
    const day = build24hReminderEmail(reminderProps).subject;
    const soon = build2hReminderEmail(reminderProps).subject;
    expect(normalizedSubject(day)).not.toBe(normalizedSubject(soon));
    assertMinimal(day);
    assertMinimal(soon);
  });
});
