import { describe, expect, it } from "vitest";
import { clientPreheader, studioPreheader } from "@/lib/email/preheader";
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

const STUDIO = "Synthetic Studio";
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

const cases: Case[] = [
  [
    "waitlist invitation",
    () =>
      buildWaitlistInvitationEmail({
        studioName: STUDIO,
        invitationUrl: `https://hone.care/invitation/${TOKEN}`,
        expiresAtLabel: "on Thursday, March 6, 2031 at 3:45 PM UTC",
      }),
    clientPreheader(STUDIO),
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

describe("waitlist family: the preview is the neutral preheader only", () => {
  it.each(cases)("%s", (label, build, expected, extra) => {
    const { html, subject } = build();
    const afterBody = html.slice(html.search(/<body\b[^>]*>/i)).replace(/^<body\b[^>]*>/i, "");
    expect(afterBody.startsWith("<div data-hone-preheader")).toBe(true);
    expect(html.match(/data-hone-preheader/g)).toHaveLength(1);
    const normalized = simulatedPreview(html);
    expect(normalized.startsWith(expected)).toBe(true);
    expect(leaks(subject, normalized.slice(expected.length), extra), `filler-stripping preview of ${label}: ${normalized}`).toEqual([]);
    const window = previewWindow(html);
    expect(window.startsWith(expected)).toBe(true);
    expect(window.slice(expected.length)).toMatch(/^[ ﻿͏\s]*$/);
    for (const re of [...FORBIDDEN, ...extra]) expect(expected).not.toMatch(re);
  });
});

describe("waitlist family: a plain-text client's preview leaks nothing", () => {
  it.each(cases)("%s", (label, build, _expected, extra) => {
    const { text, subject } = build();
    const preview = plainTextPreview(text);
    expect(leaks(subject, preview, extra), `text-part preview of ${label}: ${preview}`).toEqual([]);
  });
});

describe("waitlist family: the credential and the details are still delivered", () => {
  it.each(cases)("%s", (_label, build, _expected, extra) => {
    const { html, text } = build();
    for (const re of extra) {
      expect(text).toMatch(re);
      expect(html).toMatch(re);
    }
  });
});
