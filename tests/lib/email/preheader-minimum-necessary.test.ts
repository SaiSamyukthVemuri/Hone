import { describe, expect, it } from "vitest";
import {
  clientPreheader,
  preheaderBlock,
  studioPreheader,
  withPreheader,
} from "@/lib/email/preheader";
import {
  buildCancellationEmail,
  buildClientConfirmationEmail,
  buildPractitionerNotificationEmail,
} from "@/lib/email/templates/appointment";
import {
  build24hReminderEmail,
  build2hReminderEmail,
  buildNoShowFollowupEmail,
} from "@/lib/email/templates/reminders";
import { buildPostcareEmail } from "@/lib/email/templates/postcare";
import { buildPortalMessageNotificationEmail } from "@/lib/email/templates/portal-message-notification";
import { buildPortalReplyNotificationEmail } from "@/lib/email/templates/portal-reply-notification";
import { buildPortalMagicLinkEmail } from "@/lib/email/templates/portal-magic-link";
import { buildIntakeRequestEmail } from "@/lib/email/templates/intake-request";
import { buildIntakeReminderEmail } from "@/lib/email/templates/intake-reminder";
import {
  FORBIDDEN,
  plainTextPreview,
  previewLeaks,
  previewWindow,
  simulatedPreview,
} from "./helpers/email-preview";

// HIPAA-READY-01 (#828): the hidden PREHEADER. A mail client builds its inbox
// and lock-screen preview from the first text in the HTML body. This proves,
// for every template that gained a preheader, that the simulated preview is
// the neutral preheader and nothing else: no client name, service, date, time,
// attendance or treatment fact, and no body text leaking after it.
//
// It does NOT prove an email is PHI-free: bodies, recipients, the From line and
// the provider's records are unchanged (docs/security/email-provider-visible-inventory.md).
// Every value is synthetic and deliberately distinctive.
//
// EXCLUDED on purpose: the waitlist family (waitlist-invitation,
// waitlist-recipient-proof, new-client-waitlist). Those send through
// lib/email/new-client-waitlist-send.ts with a Resend Idempotency-Key whose
// payload must be a pure function of the key; changing their bytes can make a
// resend that spans a deploy collide under the same key. Their preheader is
// handed to the owning lane, with that deploy question attached.

const CLIENT = "Zephyrine Synthetic-Client";
const SERVICE = "Synthetic Upper Lip Electrolysis";
const STUDIO = "Synthetic Studio";
const TZ = "America/Toronto";
const START = new Date("2031-03-04T20:45:00Z");
const END = new Date("2031-03-04T21:30:00Z");
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

type Case = [
  label: string,
  build: () => { subject: string; html: string; text: string },
  expected: string,
];

const cases: Case[] = [
  [
    "client confirmation",
    () =>
      buildClientConfirmationEmail({
        ...reminderProps,
        studioEmail: "studio@synthetic.invalid",
        intakeUrl: null,
      }),
    clientPreheader(STUDIO),
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
      }),
    studioPreheader(STUDIO),
  ],
  [
    "cancellation, client-facing",
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
    clientPreheader(STUDIO),
  ],
  [
    "cancellation, studio-facing",
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
    studioPreheader(STUDIO),
  ],
  ["24h reminder", () => build24hReminderEmail(reminderProps), clientPreheader(STUDIO)],
  ["2h reminder", () => build2hReminderEmail(reminderProps), clientPreheader(STUDIO)],
  [
    "no-show follow-up",
    () => buildNoShowFollowupEmail({ clientName: CLIENT, studioName: STUDIO, rebookUrl: null }),
    clientPreheader(STUDIO),
  ],
  [
    "postcare",
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
    clientPreheader(STUDIO),
  ],
  [
    "portal message notification",
    () =>
      buildPortalMessageNotificationEmail({
        studioName: STUDIO,
        portalLoginUrl: "https://hone.care/portal/login?studio=synthetic",
      }),
    clientPreheader(STUDIO),
  ],
  [
    "portal reply notification (studio-facing)",
    () =>
      buildPortalReplyNotificationEmail({
        studioName: STUDIO,
        clientProfileUrl: "https://hone.care/clients/x",
      }),
    studioPreheader(STUDIO),
  ],
  [
    "portal magic link",
    () =>
      buildPortalMagicLinkEmail({
        studioName: STUDIO,
        magicLink: "https://hone.care/portal/verify/tok_SYNTH",
      }),
    clientPreheader(STUDIO),
  ],
  [
    "intake request (no studio name, per the intake rule)",
    () =>
      buildIntakeRequestEmail({
        studioName: STUDIO,
        intakeUrl: "https://hone.care/intake/tok_SYNTH",
      }),
    clientPreheader(null),
  ],
  [
    "intake reminder (no studio name, per the intake rule)",
    () =>
      buildIntakeReminderEmail({
        kind: "24h",
        studioName: STUDIO,
        intakeUrl: "https://hone.care/intake/tok_SYNTH",
        startsAt: START,
        timezone: TZ,
      }),
    clientPreheader(null),
  ],
];

// A client that DROPS the invisible filler (normalizes it away, as
// simulatedPreview does) shows the neutral line followed directly by the start
// of the body (Codex P2 4301045743). So the body OPENING is held to the same
// rule as the preheader: within the preview window it names only the studio.
// The client's name, the service, the date and time and any attendance or
// treatment fact come after it. There is no per-template allowance: a leak in
// any template fails. A fact the subject itself states is not a second
// disclosure (see previewLeaks).
describe("every preheader-bearing template: the preview is the neutral preheader only", () => {
  it.each(cases)("%s", (_label, build, expected) => {
    const { html, subject } = build();
    // 1. The preheader is the first content of <body>, exactly once.
    const afterBody = html.slice(html.search(/<body\b[^>]*>/i)).replace(/^<body\b[^>]*>/i, "");
    expect(afterBody.startsWith("<div data-hone-preheader")).toBe(true);
    expect(html.match(/data-hone-preheader/g)).toHaveLength(1);
    // 2. The simulated (filler-stripped) preview starts with exactly the
    //    neutral preheader, and nothing after it in that window leaks.
    const normalized = simulatedPreview(html);
    expect(normalized.startsWith(expected)).toBe(true);
    expect(previewLeaks(subject, normalized.slice(expected.length)), `filler-stripping preview of ${_label}: ${normalized}`).toEqual([]);
    // 3. ...and the client's preview window holds nothing but it and filler.
    const window = previewWindow(html);
    expect(window.startsWith(expected)).toBe(true);
    expect(window.slice(expected.length)).toMatch(/^[\u2007\ufeff\u034f\s]*$/);
    // 4. The preheader itself carries none of the forbidden facts.
    for (const re of FORBIDDEN) expect(expected).not.toMatch(re);
  });
});

describe("every preheader-bearing template: a plain-text client's preview leaks nothing", () => {
  it.each(cases)("%s", (_label, build) => {
    const { text, subject } = build();
    const preview = plainTextPreview(text);
    expect(previewLeaks(subject, preview), `text-part preview of ${_label}: ${preview}`).toEqual([]);
  });
});

describe("helper", () => {
  it("escapes the preheader text", () => {
    expect(preheaderBlock(`A <b>"x"</b> & y`)).toContain("A &lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y");
  });
  it("inserts right after <body>, or first when there is no body tag", () => {
    expect(withPreheader('<html><body class="a"><p>x</p></body></html>', "P")).toMatch(
      /^<html><body class="a"><div data-hone-preheader[^>]*>P<\/div>/,
    );
    expect(withPreheader("<p>x</p>", "P").startsWith("<div data-hone-preheader")).toBe(true);
  });
  it("the neutral copy names only the studio", () => {
    expect(clientPreheader(STUDIO)).toBe(`A message from ${STUDIO}. Open it to see the details.`);
    expect(clientPreheader("  ")).toBe("Open this message to see the details.");
    expect(studioPreheader(null)).toBe("New activity in Hone. Open it to see the details.");
  });
});
