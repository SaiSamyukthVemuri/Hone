import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildClientConfirmationEmail } from "@/lib/email/templates/appointment";
import {
  build24hReminderEmail,
  build2hReminderEmail,
} from "@/lib/email/templates/reminders";

const PORTAL = "https://hone.care/portal/login?studio=willow";
const CTA = "secure client portal";

const baseConf = {
  clientName: "Sam",
  studioName: "Willow",
  studioAddress: null,
  studioEmail: "owner@example.com",
  practitionerName: null,
  serviceName: "Electrolysis",
  durationMinutes: 45,
  startsAt: new Date("2026-06-03T18:30:00Z"),
  endsAt: new Date("2026-06-03T19:15:00Z"),
  timezone: "America/Toronto",
  cancellationUrl: "https://hone.care/cancel/APPTTOK",
  rescheduleUrl: "https://hone.care/reschedule/APPTTOK",
  intakeUrl: null,
  preCareInstructions: null,
  treatmentTimeLine: null,
};
const baseRem = {
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

function assertPortalCta(email: { html: string; text: string }) {
  // CTA present in both html + text
  expect(email.html).toContain(CTA);
  expect(email.text).toContain(CTA);
  expect(email.html).toContain(PORTAL);
  expect(email.text).toContain(PORTAL);
  // token-FREE: the studio login page, never a one-time magic-link/token
  expect(email.html).toContain("/portal/login?studio=");
  expect(email.html).not.toMatch(/\/portal\/verify\//);
  // existing manage links preserved
  expect(email.html).toContain("https://hone.care/cancel/APPTTOK");
  expect(email.html).toContain("https://hone.care/reschedule/APPTTOK");
}

describe("confirmation email — portal CTA (token-free), existing links kept", () => {
  it("includes the portal CTA when a portalLoginUrl is provided", () => {
    assertPortalCta(buildClientConfirmationEmail({ ...baseConf, portalLoginUrl: PORTAL }));
  });
  it("omits the CTA when no portalLoginUrl (optional, back-compatible)", () => {
    const e = buildClientConfirmationEmail(baseConf);
    expect(e.html).not.toContain(CTA);
    expect(e.text).not.toContain(CTA);
    // manage links still there
    expect(e.html).toContain("https://hone.care/cancel/APPTTOK");
  });
});

describe("reminder emails (24h + 2h) — portal CTA (token-free)", () => {
  it("24h reminder includes the portal CTA", () => {
    assertPortalCta(build24hReminderEmail({ ...baseRem, portalLoginUrl: PORTAL }));
  });
  it("2h reminder includes the portal CTA", () => {
    assertPortalCta(build2hReminderEmail({ ...baseRem, portalLoginUrl: PORTAL }));
  });
  it("reminders omit the CTA when no portalLoginUrl", () => {
    expect(build24hReminderEmail(baseRem).html).not.toContain(CTA);
    expect(build2hReminderEmail(baseRem).text).not.toContain(CTA);
  });
});

describe("CTA copy + no clinical/intake/payment data added", () => {
  it("uses the exact forms/appointments/care-instructions copy", () => {
    const e = buildClientConfirmationEmail({ ...baseConf, portalLoginUrl: PORTAL });
    expect(e.text).toMatch(
      /View your forms, appointments, and care instructions in your secure client portal/,
    );
  });
});

describe("wiring: senders derive a token-free portal URL; login copy fixed", () => {
  function read(rel: string) {
    return readFileSync(path.resolve(__dirname, "../../../", rel), "utf8");
  }
  const SENDER = read("lib/email/send-appointment.ts");
  const LOGIN_PAGE = read("app/portal/login/page.tsx");
  const LOGIN_ACTION = read("app/portal/login/actions.ts");
  it("senders build /portal/login?studio=slug (no token) and pass it to the 3 emails", () => {
    expect(SENDER).toMatch(/\/portal\/login\?studio=\$\{encodeURIComponent\(slug\)\}/);
    expect(SENDER.match(/portalLoginUrl: portalLoginUrlForStudio\(/g)?.length).toBe(3);
    expect(SENDER).not.toMatch(/portalLoginUrlForStudio[\s\S]{0,120}verify/);
  });
  it("login page now says 1 hour, not 30 minutes", () => {
    expect(LOGIN_PAGE).toMatch(/expires in 1 hour/);
    expect(LOGIN_PAGE).not.toMatch(/30 minutes/);
  });
  it("public login enumeration behavior is unchanged (action untouched)", () => {
    expect(LOGIN_ACTION).toMatch(/GENERIC_SUCCESS/);
    expect(LOGIN_ACTION).toMatch(/If that email is on file/);
  });
});
