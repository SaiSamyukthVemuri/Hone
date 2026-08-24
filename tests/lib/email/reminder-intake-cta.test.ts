import { describe, expect, it } from "vitest";
import {
  build24hReminderEmail,
  build2hReminderEmail,
} from "@/lib/email/templates/reminders";
import {
  INTAKE_CTA_LABEL,
  INTAKE_IGNORE_LINE,
  INTAKE_SECTION_COPY,
} from "@/lib/email/templates/intake-reminder";

// The intake CTA COMPOSED INTO the appointment reminder (0186). One email per
// appointment per window: when the client's latest intake is still in_progress
// at the send decision, the cron passes a fresh link and the reminder grows an
// intake section. When it does not, the reminder is byte-for-byte what it was.

const INTAKE_URL = "https://hone.care/intake/eyJhbGciOi.sig";

// The templates HTML-escape their copy, so the 2h body's apostrophe reaches
// the markup as &#39;. Assert against the same escaping the template applies.
const htmlEscape = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");


const base = {
  clientName: "Sam",
  studioName: "Willow",
  studioAddress: null,
  practitionerName: null,
  serviceName: "Electrolysis",
  durationMinutes: 45,
  startsAt: new Date("2026-06-03T18:30:00Z"),
  endsAt: new Date("2026-06-03T19:15:00Z"),
  timezone: "America/Toronto",
  cancellationUrl: "https://hone.care/cancel/APPTTOK",
  rescheduleUrl: "https://hone.care/reschedule/APPTTOK",
  preCareInstructions: null,
  treatmentTimeLine: null,
};

const BUILDERS = [
  { kind: "24h" as const, build: build24hReminderEmail },
  { kind: "2h" as const, build: build2hReminderEmail },
];

describe.each(BUILDERS)("$kind reminder without an intake link", ({ build }) => {
  const email = build({ ...base });

  it("renders NO intake section at all", () => {
    const all = `${email.subject}\n${email.html}\n${email.text}`;
    expect(all).not.toContain(INTAKE_CTA_LABEL);
    expect(all).not.toContain(INTAKE_SECTION_COPY["24h"].heading);
    expect(all).not.toContain(INTAKE_SECTION_COPY["2h"].heading);
    expect(all).not.toContain("/intake/");
  });

  it("is unchanged when intakeUrl is explicitly null", () => {
    const withNull = build({ ...base, intakeUrl: null });
    expect(withNull.html).toBe(email.html);
    expect(withNull.text).toBe(email.text);
    expect(withNull.subject).toBe(email.subject);
  });

  it("does not render the caveat either - it belongs to the intake section", () => {
    expect(email.text).not.toContain(INTAKE_IGNORE_LINE);
    expect(email.html).not.toContain(htmlEscape(INTAKE_IGNORE_LINE));
  });
});

describe.each(BUILDERS)("$kind reminder WITH an intake link", ({ kind, build }) => {
  const plain = build({ ...base });
  const email = build({ ...base, intakeUrl: INTAKE_URL });
  const { heading, body } = INTAKE_SECTION_COPY[kind];

  it("carries this window's ruled heading, body and CTA in html AND text", () => {
    expect(email.text).toContain(heading);
    expect(email.text).toContain(body);
    expect(email.html).toContain(htmlEscape(heading));
    expect(email.html).toContain(htmlEscape(body));
    for (const rendered of [email.html, email.text]) {
      expect(rendered).toContain(INTAKE_CTA_LABEL);
      expect(rendered).toContain(INTAKE_URL);
    }
  });

  it("uses the OTHER window's copy nowhere", () => {
    const other = kind === "24h" ? "2h" : "24h";
    const all = `${email.html}\n${email.text}`;
    expect(all).not.toContain(INTAKE_SECTION_COPY[other].heading);
    expect(all).not.toContain(INTAKE_SECTION_COPY[other].body);
    expect(all).not.toContain(htmlEscape(INTAKE_SECTION_COPY[other].body));
  });

  it("ADDS to the appointment reminder rather than replacing it", () => {
    // Everything the plain reminder said is still said.
    for (const fragment of [
      base.serviceName,
      base.studioName,
      base.cancellationUrl,
      base.rescheduleUrl,
      "Duration: 45 minutes",
    ]) {
      expect(plain.text).toContain(fragment);
      expect(email.text).toContain(fragment);
    }
    expect(email.text.length).toBeGreaterThan(plain.text.length);
  });

  it("carries the completed-form caveat, so it stays true if the client submits before delivery", () => {
    // Intake state is read LIVE before the send decision, but the client can
    // still submit between that read and provider delivery. This line is what
    // keeps the section truthful when it loses that race - the same constant
    // the standalone intake email uses, never a second wording.
    expect(email.text).toContain(INTAKE_IGNORE_LINE);
    expect(email.html).toContain(htmlEscape(INTAKE_IGNORE_LINE));
  });

  it("places the caveat after the CTA, as the closing line of the section", () => {
    const ctaAt = email.text.indexOf(INTAKE_CTA_LABEL);
    const caveatAt = email.text.indexOf(INTAKE_IGNORE_LINE);
    expect(ctaAt).toBeGreaterThan(-1);
    expect(caveatAt).toBeGreaterThan(ctaAt);
  });

  it("keeps the appointment-reminder subject, with no intake wording", () => {
    expect(email.subject).toBe(plain.subject);
    expect(email.subject).toMatch(/^Reminder: Electrolysis (tomorrow|today) at /);
    expect(email.subject).not.toMatch(/intake|incomplete|form/i);
  });

  // PLACEMENT IS THE PRIVACY GUARD. These templates carry no preheader
  // element, so mail clients derive preview text from the first visible nodes.
  // Keeping the intake section BELOW the appointment details keeps
  // intake-completion state off the recipient's lock screen.
  it("renders the intake section AFTER the appointment details, in html and text", () => {
    for (const rendered of [email.html, email.text]) {
      const detailsAt = rendered.indexOf(base.serviceName);
      const headingAt = rendered.indexOf(heading);
      expect(detailsAt).toBeGreaterThan(-1);
      expect(headingAt).toBeGreaterThan(detailsAt);
    }
  });

  it("puts nothing about intake in the first 120 characters of the text body", () => {
    // A crude but honest proxy for the preview-text window.
    const preview = email.text.slice(0, 120);
    expect(preview).not.toMatch(/intake/i);
  });

  it("escapes the link in the copy-paste fallback and makes no overclaim", () => {
    expect(email.html).toContain("copy and paste this link");
    const all = `${email.subject}\n${email.text}\n${email.html}`;
    expect(all).not.toMatch(/\b(delivered|received|opened)\b/i);
    expect(all).not.toMatch(/still incomplete/i);
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT the P2 was raised against
// ---------------------------------------------------------------------------
describe("every composed branch that carries the intake CTA carries the caveat", () => {
  it("holds for both windows, both renderings, with and without a link", () => {
    const checked: string[] = [];
    for (const { kind, build } of BUILDERS) {
      for (const intakeUrl of [INTAKE_URL, null]) {
        const email = build({ ...base, intakeUrl });
        const branches: Array<[string, string, string]> = [
          [`${kind}/html`, email.html, htmlEscape(INTAKE_IGNORE_LINE)],
          [`${kind}/text`, email.text, INTAKE_IGNORE_LINE],
        ];
        for (const [label, rendered, caveat] of branches) {
          const hasCta = rendered.includes(INTAKE_CTA_LABEL);
          // CTA present => caveat present. CTA absent => neither.
          expect(
            rendered.includes(caveat),
            `${label} (link=${intakeUrl !== null})`,
          ).toBe(hasCta);
          checked.push(label);
        }
      }
    }
    // Guard against the loop silently checking nothing.
    expect(checked).toHaveLength(8);
  });
});
