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
const PREVIEW_CHARS = 140;

const FORBIDDEN: RegExp[] = [
  /Zephyrine/,
  /Electrolysis|Upper Lip/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b(AM|PM)\b/,
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  /\b(today|tomorrow|tonight|missed|aftercare|treatment|cancel)/i,
  /\b2031\b/,
];

const decode = (s: string) =>
  s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

/** What a mail client shows as the preview: the first visible-text characters of <body>. */
function simulatedPreview(html: string): string {
  const body = html.slice(html.search(/<body\b[^>]*>/i));
  const text = decode(
    body
      .replace(/<(style|title|head)[\s\S]*?<\/\1>/gi, "")
      .replace(/<[^>]+>/g, " "),
  );
  // Filler code points render as nothing; drop them and collapse whitespace.
  return text
    .replace(/[ ﻿͏]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, PREVIEW_CHARS);
}

function previewWindow(html: string): string {
  // The characters a client takes BEFORE any body text could appear: the
  // preheader plus the filler, decoded but not collapsed.
  const body = html.slice(html.search(/<body\b[^>]*>/i));
  return decode(body.replace(/<[^>]+>/g, "")).slice(0, PREVIEW_CHARS);
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

type Case = [label: string, build: () => { html: string }, expected: string];

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
// of the body. The preheader does NOT protect those clients (Codex P2
// 4301045743): for the templates below, the start of the body carries these
// forbidden facts. Pinned EXACTLY, so any new leak, or any leak in a template
// not listed here, fails. Removing them needs the body openings rewritten,
// which is a copy and design decision (queued via #828), not this test.
const KNOWN_FILLER_STRIPPING_LEAKS: Record<string, string[]> = {
  "client confirmation": ["/Zephyrine/"],
  "cancellation, client-facing": ["/Zephyrine/", "/\\b(today|tomorrow|tonight|missed|aftercare|treatment|cancel)/i"],
  "cancellation, studio-facing": ["/Zephyrine/", "/\\b(today|tomorrow|tonight|missed|aftercare|treatment|cancel)/i"],
  "24h reminder": ["/Zephyrine/", "/\\b(today|tomorrow|tonight|missed|aftercare|treatment|cancel)/i"],
  "2h reminder": ["/Zephyrine/"],
  "no-show follow-up": ["/Zephyrine/", "/\\b(today|tomorrow|tonight|missed|aftercare|treatment|cancel)/i"],
  postcare: [
    "/Zephyrine/",
    "/\\b\\d{1,2}:\\d{2}\\b/",
    "/\\b(AM|PM)\\b/",
    "/\\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\b/i",
    "/\\b(January|February|March|April|May|June|July|August|September|October|November|December)\\b/i",
    "/\\b2031\\b/",
  ],
  "intake reminder (no studio name, per the intake rule)": [
    "/\\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\\b/i",
    "/\\b(January|February|March|April|May|June|July|August|September|October|November|December)\\b/i",
    "/\\b2031\\b/",
  ],
};

describe("every preheader-bearing template: the preview is the neutral preheader only", () => {
  it.each(cases)("%s", (_label, build, expected) => {
    const { html } = build();
    // 1. The preheader is the first content of <body>, exactly once.
    const afterBody = html.slice(html.search(/<body\b[^>]*>/i)).replace(/^<body\b[^>]*>/i, "");
    expect(afterBody.startsWith("<div data-hone-preheader")).toBe(true);
    expect(html.match(/data-hone-preheader/g)).toHaveLength(1);
    // 2. The simulated (filler-stripped) preview starts with exactly the
    //    neutral preheader, and what follows it in that same preview window
    //    leaks EXACTLY the pinned facts for this template, nothing more.
    const normalized = simulatedPreview(html);
    expect(normalized.startsWith(expected)).toBe(true);
    const rest = normalized.slice(expected.length);
    const leaked = FORBIDDEN.filter((re) => re.test(rest)).map(String).sort();
    expect(leaked, `filler-stripping preview of ${_label}`).toEqual(
      [...(KNOWN_FILLER_STRIPPING_LEAKS[_label] ?? [])].sort(),
    );
    // 3. ...and the client's preview window holds nothing but it and filler.
    const window = previewWindow(html);
    expect(window.startsWith(expected)).toBe(true);
    expect(window.slice(expected.length)).toMatch(/^[ ﻿͏\s]*$/);
    // 4. The preheader itself carries none of the forbidden facts.
    for (const re of FORBIDDEN) expect(expected).not.toMatch(re);
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
