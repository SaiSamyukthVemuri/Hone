import { describe, expect, it } from "vitest";
import { clientPreheader, studioPreheader } from "@/lib/email/preheader";
import { sanitizeStudioDisplayName } from "@/lib/email/studio-identity";
import { buildWaitlistInvitationEmail } from "@/lib/email/templates/waitlist-invitation";
import { buildWaitlistRecipientProofEmail } from "@/lib/email/templates/waitlist-recipient-proof";
import {
  buildNewClientWaitlistClientEmail,
  buildNewClientWaitlistStudioEmail,
} from "@/lib/email/templates/new-client-waitlist";
import {
  FORBIDDEN,
  plainTextPreview,
  previewLeaks,
  previewWindow,
  simulatedPreview,
} from "./helpers/email-preview";

// HIPAA-READY-01 (#828), extended to the waitlist family that #1049 left out.
// Same rule and same whole-word preview window as
// preheader-minimum-necessary.test.ts: the inbox / lock-screen preview, in a
// client that keeps the preheader filler, one that strips it, and a
// plain-text client, names only the studio.
//
// These four emails also carry facts the shared list does not name, and each
// is held to its own extra patterns:
//   * the invitation's link is a BEARER CREDENTIAL (the raw token);
//   * the proof email's code is a CREDENTIAL, and its template already states
//     that the code must not reach a lock-screen notification;
//   * the studio notification carries the prospect's email and phone.
//
// Every value is synthetic and deliberately distinctive.

// Codex P1 4355048631 on #1049: run at the SHORTEST admissible studio name
// (one non-blank character: app/(app)/settings/studio/actions.ts:39-41 and
// lib/studios/new-studio.ts:83-84), the usual one and a long one.
const STUDIO_NAMES = ["Q", "Synthetic Studio", "Synthetic Studio of the Northern Riverside Wellness Collective"];
const CLIENT = "Zephyrine Synthetic-Client";
const CLIENT_EMAIL = "zephyrine@synthetic.invalid";
const CLIENT_PHONE = "+1 555 0142 777";
const TOKEN = "tokSYNTHsecret9QX";
const CODE = "K7Q2M9XD";

type Case = [
  label: string,
  build: () => { subject: string; html: string; text: string },
  preheader: string,
  extra: RegExp[],
];

const casesFor = (STUDIO: string): Case[] => [
  [
    "waitlist invitation",
    () =>
      buildWaitlistInvitationEmail({
        studioName: STUDIO,
        invitationUrl: `https://hone.care/invitation/${TOKEN}`,
        expiresAtLabel: "on Thursday, March 6, 2031 at 3:45 PM UTC",
      }),
    // The template sanitizes (and length-caps) the name before using it.
    clientPreheader(sanitizeStudioDisplayName(STUDIO) ?? ""),
    [new RegExp(TOKEN), /hone\.care\/invitation/],
  ],
  [
    "waitlist recipient proof (book)",
    () => buildWaitlistRecipientProofEmail({ studioName: STUDIO, code: CODE, windowMinutes: 15, action: "book" }),
    clientPreheader(STUDIO),
    [new RegExp(CODE)],
  ],
  [
    "waitlist recipient proof (decline)",
    () => buildWaitlistRecipientProofEmail({ studioName: STUDIO, code: CODE, windowMinutes: 15, action: "decline" }),
    clientPreheader(STUDIO),
    [new RegExp(CODE)],
  ],
  [
    "new-client waitlist, client acknowledgement",
    () => buildNewClientWaitlistClientEmail({ studioName: STUDIO, name: CLIENT }),
    clientPreheader(STUDIO),
    [],
  ],
  [
    "new-client waitlist, studio notification",
    () => buildNewClientWaitlistStudioEmail({ studioName: STUDIO, name: CLIENT, email: CLIENT_EMAIL, phone: CLIENT_PHONE }),
    studioPreheader(STUDIO),
    [/synthetic\.invalid/, /555 0142/],
  ],
];

const leaks = (subject: string, preview: string, extra: RegExp[]) => [
  ...previewLeaks(subject, preview),
  ...extra.filter((re) => re.test(preview)).map(String),
];

// When the neutral preheader is longer than the window, the window is a prefix
// of it; otherwise it opens with it and the remainder is checked.
function afterPreheader(preview: string, preheader: string): string | null {
  if (preheader.startsWith(preview)) return "";
  if (preview.startsWith(preheader)) return preview.slice(preheader.length);
  return null;
}

describe.each(STUDIO_NAMES)("waitlist family, studio %j: the preview is the neutral preheader only", (studioName) => {
  it.each(casesFor(studioName))("%s", (label, build, expected, extra) => {
    const { html, subject } = build();
    const afterBody = html.slice(html.search(/<body\b[^>]*>/i)).replace(/^<body\b[^>]*>/i, "");
    expect(afterBody.startsWith("<div data-hone-preheader")).toBe(true);
    expect(html.match(/data-hone-preheader/g)).toHaveLength(1);
    const normalized = simulatedPreview(html);
    const rest = afterPreheader(normalized, expected);
    expect(rest, `preview does not open with the preheader: ${normalized}`).not.toBeNull();
    expect(leaks(subject, rest ?? "", extra), `filler-stripping preview of ${label}: ${normalized}`).toEqual([]);
    const window = previewWindow(html);
    const windowRest = afterPreheader(window, expected);
    expect(windowRest).not.toBeNull();
    expect(windowRest ?? "").toMatch(/^[\u2007\ufeff\u034f\s]*$/);
    for (const re of [...FORBIDDEN, ...extra]) expect(expected).not.toMatch(re);
  });
});

describe.each(STUDIO_NAMES)("waitlist family, studio %j: a plain-text client's preview leaks nothing", (studioName) => {
  it.each(casesFor(studioName))("%s", (label, build, _expected, extra) => {
    const { text, subject } = build();
    const preview = plainTextPreview(text);
    expect(leaks(subject, preview, extra), `text-part preview of ${label}: ${preview}`).toEqual([]);
  });
});

describe("waitlist family: the credential and the details are still delivered", () => {
  it.each(casesFor("Synthetic Studio"))("%s", (_label, build, _expected, extra) => {
    const { html, text } = build();
    for (const re of extra) {
      expect(text).toMatch(re);
      expect(html).toMatch(re);
    }
  });
});
