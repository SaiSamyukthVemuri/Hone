import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
import { buildIntakeReminderEmail } from "@/lib/email/templates/intake-reminder";
import { buildIntakeRequestEmail } from "@/lib/email/templates/intake-request";
import { buildPortalMagicLinkEmail } from "@/lib/email/templates/portal-magic-link";
import { buildPortalMessageNotificationEmail } from "@/lib/email/templates/portal-message-notification";
import { buildPortalReplyNotificationEmail } from "@/lib/email/templates/portal-reply-notification";
import { buildInvitationEmail } from "@/lib/email/templates/invitation";
import { buildWelcomeEmail } from "@/lib/email/templates/welcome";
import { buildWaitlistRecipientProofEmail } from "@/lib/email/templates/waitlist-recipient-proof";
import { buildWaitlistInvitationEmail } from "@/lib/email/templates/waitlist-invitation";
import {
  buildNewClientWaitlistClientEmail,
  buildNewClientWaitlistStudioEmail,
} from "@/lib/email/templates/new-client-waitlist";
import { buildAppointmentMovedEmail } from "@/lib/email/notify-appointment-moved";
import { FORBIDDEN, plainTextPreview, previewLeaks, simulatedPreview } from "./helpers/email-preview";

// ===========================================================================
// THE EMAIL SUBJECT SWEEP (#1049 Codex rounds 1–3: 4354990813, 4354990818,
// 4355048639, 4355360162, 4355360168, 4355360172).
//
// Every round found another template whose minimum-necessary subject was
// identical for two DIFFERENT events to one recipient, so Gmail and Outlook
// thread them together and bury the newer one. Fixing one template per round
// does not converge, so this file decides EVERY email at once:
//
//   * PER_EVENT: two distinct events can reach the same recipient (two
//     bookings, two cancellations, a 24h reminder per appointment, ...). The
//     subject carries a non-sensitive per-event reference
//     (lib/email/booking-reference.ts), so distinct events have distinct
//     normalized subjects while one event keeps one subject (a retry does not
//     fork a thread).
//   * SUPERSEDES: a newer message makes every older one obsolete (a fresh
//     sign-in link, a fresh code, a pointer to the same portal inbox, a
//     re-invite). Threading them is harmless, so the subject stays stable.
//     The reason is recorded per entry.
//   * HELD: a decision outside this lane, named with its owner.
//
// The LISTS ARE DERIVED FROM THE SOURCE, not maintained by hand. Every
// exported `build…Email` / `render…Email` in lib/email/templates/** and
// lib/email/notify-appointment-moved.ts must have a decision here, and every
// file that SENDS an email must be listed with the builders it uses. A new
// template or a new send site without a decision fails this file.
//
// Every subject is checked against the subject rule (no client name, service,
// date or time), and every built email's inbox preview (filler-stripping HTML
// and plain text) at the SHORTEST studio name the product admits (one
// non-blank character; app/(app)/settings/studio/actions.ts:39-41,
// lib/studios/new-studio.ts:83-84) and at a long one.
// ===========================================================================

const ROOT = path.resolve(__dirname, "../../..");
const SHORTEST = "Q";
const LONG = "Synthetic Studio of the Northern Riverside Wellness Collective";
const CLIENT = "Zephyrine Synthetic-Client";
const SERVICE = "Synthetic Upper Lip Electrolysis";
const TZ = "America/Toronto";
const START = new Date("2031-03-04T20:45:00Z");
const END = new Date("2031-03-04T21:30:00Z");

// The subject rule: no client name, service, date or time (relative dates too).
// "Appointment cancelled" may stand in a subject, so the attendance word list
// of the preview rule is not applied to subjects.
const SUBJECT_FORBIDDEN: RegExp[] = [
  /Zephyrine/,
  /Electrolysis|Upper Lip/i,
  /\b\d{1,2}:\d{2}\b/,
  /\b(AM|PM)\b/,
  /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  /\b(today|tomorrow|tonight)\b/i,
  /\b2031\b/,
];

type Email = { subject: string; html: string; text: string };

type Decision =
  | { kind: "PER_EVENT"; build: (studio: string, ref: string) => Email; event: string }
  | { kind: "SUPERSEDES"; build: (studio: string) => Email; why: string }
  | { kind: "HELD"; why: string; owner: string };

/**
 * Entries whose fix lives on the stacked #1051 (fix/email-minimum-necessary-remaining),
 * which owns these templates. The decision is RECORDED here; it is ENFORCED
 * there, where this set is emptied.
 */
// Emptied on #1051, which owns the waitlist templates: every decision is enforced.
const ENFORCED_ON_1051 = new Set<string>([]);

const reminderProps = (studio: string, ref: string) => ({
  clientName: CLIENT,
  studioName: studio,
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
  bookingReference: ref,
});

const cancellation = (isClient: boolean) => (studio: string, ref: string) =>
  buildCancellationEmail({
    recipientName: isClient ? CLIENT : "Synthetic Practitioner",
    clientName: CLIENT,
    studioName: studio,
    serviceName: SERVICE,
    durationMinutes: 45,
    startsAt: START,
    timezone: TZ,
    actorName: isClient ? null : CLIENT,
    actorRole: isClient ? "practitioner" : "client",
    reason: null,
    isClient,
    bookingReference: ref,
  });

const moved = (kind: "moved" | "reassigned" | "moved_and_reassigned") => (studio: string, ref: string) =>
  buildAppointmentMovedEmail({
    kind,
    studioName: studio,
    serviceName: SERVICE,
    startsAt: START,
    timezone: TZ,
    practitionerName: "Synthetic Practitioner",
    manageUrl: "https://hone.care/manage/tok_SYNTH",
    rescheduleUrl: "https://hone.care/reschedule/tok_SYNTH",
    bookingReference: ref,
  });

/** The decision for every builder, keyed by its exported name. */
const DECISIONS: Record<string, Decision[]> = {
  buildClientConfirmationEmail: [{
    kind: "PER_EVENT", event: "each booking",
    build: (s, ref) => buildClientConfirmationEmail({ ...reminderProps(s, ref), studioEmail: "studio@synthetic.invalid", intakeUrl: null }),
  }],
  buildPractitionerNotificationEmail: [{
    kind: "PER_EVENT", event: "each booking (to the practitioner/owner)",
    build: (s, ref) => buildPractitionerNotificationEmail({
      practitionerName: "Synthetic Practitioner", clientName: CLIENT, clientEmail: "client@synthetic.invalid",
      clientPhone: null, studioName: s, serviceName: SERVICE, startsAt: START, endsAt: END, timezone: TZ,
      notes: null, appointmentUrl: "https://hone.care/calendar/x", referralSourceLabel: null, bookingReference: ref,
    }),
  }],
  buildCancellationEmail: [
    { kind: "PER_EVENT", event: "each cancelled booking (client)", build: cancellation(true) },
    { kind: "PER_EVENT", event: "each cancelled booking (owner/practitioner; Codex 4355360172)", build: cancellation(false) },
  ],
  build24hReminderEmail: [{ kind: "PER_EVENT", event: "each booking's 24h reminder (Codex 4355360168)", build: (s, ref) => build24hReminderEmail(reminderProps(s, ref)) }],
  build2hReminderEmail: [{ kind: "PER_EVENT", event: "each booking's 2h reminder", build: (s, ref) => build2hReminderEmail(reminderProps(s, ref)) }],
  buildNoShowFollowupEmail: [{
    kind: "PER_EVENT", event: "each missed booking",
    build: (s, ref) => buildNoShowFollowupEmail({ clientName: CLIENT, studioName: s, rebookUrl: null, bookingReference: ref }),
  }],
  buildPostcareEmail: [{
    kind: "PER_EVENT", event: "each completed visit",
    build: (s, ref) => buildPostcareEmail({
      clientName: CLIENT, studioName: s, studioEmail: null, practitionerName: "Synthetic Practitioner",
      serviceName: SERVICE, startsAt: START, timezone: TZ, aftercareText: "Synthetic aftercare text.",
      warningSignsText: null, productRecommendationsText: null, reviewUrl: null, bookingReference: ref,
    }),
  }],
  buildIntakeReminderEmail: [{
    kind: "PER_EVENT", event: "each booking's standalone intake reminder",
    build: (s, ref) => buildIntakeReminderEmail({ kind: "24h", studioName: s, intakeUrl: "https://hone.care/intake/tok_SYNTH", startsAt: START, timezone: TZ, bookingReference: ref }),
  }],
  buildIntakeRequestEmail: [{
    kind: "PER_EVENT", event: "each reissued intake form (a new intake row per reissue)",
    build: (s, ref) => buildIntakeRequestEmail({ studioName: s, intakeUrl: "https://hone.care/intake/tok_SYNTH", intakeReference: ref }),
  }],
  buildAppointmentMovedEmail: [
    { kind: "PER_EVENT", event: "each moved booking (Codex 4355360162)", build: moved("moved") },
    { kind: "PER_EVENT", event: "each reassigned booking", build: moved("reassigned") },
    { kind: "PER_EVENT", event: "each moved and reassigned booking", build: moved("moved_and_reassigned") },
  ],
  buildPortalMagicLinkEmail: [{
    kind: "SUPERSEDES", why: "Each request mints a fresh sign-in link; only the newest matters, and PR #127 already rewords the subject for exactly this.",
    build: (s) => buildPortalMagicLinkEmail({ studioName: s, magicLink: "https://hone.care/portal/verify/tok_SYNTH" }),
  }],
  buildPortalMessageNotificationEmail: [{
    kind: "SUPERSEDES", why: "Carries no message content: every notice points to the same secure portal inbox, which shows every message whichever notice is opened.",
    build: (s) => buildPortalMessageNotificationEmail({ studioName: s, portalLoginUrl: "https://hone.care/portal/login?studio=synthetic" }),
  }],
  buildPortalReplyNotificationEmail: [{
    kind: "SUPERSEDES", why: "Studio-facing pointer with no content: every notice opens the same client profile message list.",
    build: (s) => buildPortalReplyNotificationEmail({ studioName: s, clientProfileUrl: "https://hone.care/clients/x" }),
  }],
  buildInvitationEmail: [{
    kind: "SUPERSEDES", why: "One per studio membership; a re-invite replaces the previous one, and the studio name already separates different studios. Staff-facing; takes no client data.",
    build: (s) => buildInvitationEmail({ inviteeEmail: "staff@synthetic.invalid", inviteeDisplayName: "Synthetic Practitioner", studioName: s, inviterName: "Synthetic Owner" }),
  }],
  buildWelcomeEmail: [{
    kind: "SUPERSEDES", why: "One per new studio owner; a resend replaces the previous one. Staff-facing; takes no client data.",
    build: (s) => buildWelcomeEmail({ ownerDisplayName: "Synthetic Owner", ownerEmail: "owner@synthetic.invalid", studioName: s, bookingUrl: "" }),
  }],
  buildWaitlistRecipientProofEmail: [{
    kind: "SUPERSEDES", why: "A new code makes every earlier code stop working, and the body says so (template header, 'KNOWN LIMITATION').",
    build: (s) => buildWaitlistRecipientProofEmail({ studioName: s, code: "K7Q2M9XD", windowMinutes: 15, action: "book" }),
  }],
  buildWaitlistInvitationEmail: [{
    kind: "PER_EVENT", event: "each invitation (an entry can be invited, expire, requeue and be invited again)",
    build: (s, ref) => buildWaitlistInvitationEmail({ studioName: s, invitationUrl: "https://hone.care/invitation/tokSYNTH", expiresAtLabel: "on Thursday, March 6, 2031 at 3:45 PM UTC", invitationReference: ref }),
  }],
  buildNewClientWaitlistClientEmail: [{
    kind: "PER_EVENT", event: "each waitlist join (a removed person may rejoin)",
    build: (s, ref) => buildNewClientWaitlistClientEmail({ studioName: s, name: CLIENT, joinReference: ref }),
  }],
  buildNewClientWaitlistStudioEmail: [{
    kind: "PER_EVENT", event: "each waitlist join (to the owner)",
    build: (s, ref) => buildNewClientWaitlistStudioEmail({ studioName: s, name: CLIENT, email: "zephyrine@synthetic.invalid", phone: null, joinReference: ref }),
  }],
  buildPaymentReceiptEmail: [{ kind: "HELD", owner: "Sam + legal", why: "Lawyer-approved receipt strings (lib/billing/receipt-document.ts 'DO NOT PARAPHRASE'); proposal in privacy/PRIV-EMAIL-REST-END.json R1." }],
  renderReceiptEmail: [{ kind: "HELD", owner: "Sam + legal", why: "Same document as buildPaymentReceiptEmail." }],
};

/** Every file that sends email, and the builders it renders (or why it renders none). */
const SEND_SITES: Record<string, string[] | { inline: string }> = {
  "lib/email/send-appointment.ts": [
    "buildClientConfirmationEmail", "buildPractitionerNotificationEmail", "buildCancellationEmail",
    "build24hReminderEmail", "build2hReminderEmail", "buildIntakeReminderEmail", "buildNoShowFollowupEmail",
    "buildPostcareEmail", "buildIntakeRequestEmail",
  ],
  "lib/email/notify-appointment-moved.ts": ["buildAppointmentMovedEmail"],
  "lib/email/send-welcome.ts": ["buildWelcomeEmail"],
  "lib/email/new-client-waitlist-send.ts": { inline: "transport wrapper: sends what its callers built" },
  "lib/waitlist/delivery/send.ts": ["buildWaitlistInvitationEmail", "buildWaitlistRecipientProofEmail"],
  "app/book/[slug]/waitlist-actions.ts": ["buildNewClientWaitlistClientEmail", "buildNewClientWaitlistStudioEmail"],
  "lib/portal/magic-link.ts": ["buildPortalMagicLinkEmail"],
  "app/portal/login/actions.ts": ["buildPortalMagicLinkEmail"],
  "app/portal/portal-message-actions.ts": ["buildPortalReplyNotificationEmail"],
  "app/(app)/clients/[id]/portal-messages-actions.ts": ["buildPortalMessageNotificationEmail"],
  "app/(app)/settings/team/actions.ts": ["buildInvitationEmail"],
  "lib/billing/payment-receipt.ts": ["buildPaymentReceiptEmail"],
  "lib/ops/alert-email.ts": {
    inline: "operator alert; subject is `[Hone CRITICAL] <event slug>`: grouping one failure class in one thread is intended, and it names no client, record or time",
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
const rel = (p: string) => path.relative(ROOT, p).split(path.sep).join("/");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function discoveredBuilders(): string[] {
  const files = [
    ...walk(path.join(ROOT, "lib/email/templates")),
    path.join(ROOT, "lib/email/notify-appointment-moved.ts"),
  ];
  return files
    .flatMap((f) => [...strip(readFileSync(f, "utf8")).matchAll(/export\s+function\s+((?:build|render)\w*Email)\s*\(/g)].map((m) => m[1]))
    .sort();
}

function discoveredSendSites(): string[] {
  const files = [...walk(path.join(ROOT, "lib")), ...walk(path.join(ROOT, "app"))];
  return files
    .filter((f) => {
      const src = strip(readFileSync(f, "utf8"));
      return /(?<!function\s)\bsendEmailSafely\s*\(|\bemails\.send\s*\(|(?<!function\s)\bsendWaitlistEmailIdempotent\s*\(/.test(src);
    })
    .map(rel)
    .sort();
}

const normalized = (s: string) =>
  s.replace(/^\s*((re|fwd?|aw|sv)\s*:\s*)+/i, "").replace(/\s+/g, " ").trim().toLowerCase();

// The preview rule's list, except that the SERVICE is matched by the synthetic
// service's distinctive words: staff emails describe Hone itself as "the
// charting tool for electrolysis and laser practitioners", which is product
// copy, not a client's service.
const GENERIC_SERVICE = String(/Electrolysis|Upper Lip/i);
function previewRest(html: string, text: string, subject: string): string[] {
  const leaks: string[] = [];
  for (const preview of [simulatedPreview(html), plainTextPreview(text)]) {
    leaks.push(...previewLeaks(subject, preview).filter((l) => l !== GENERIC_SERVICE));
    if (/Upper Lip/i.test(preview)) leaks.push("service (Upper Lip)");
  }
  return [...new Set(leaks)].sort();
}

describe("the sweep covers every email (derived from the source)", () => {
  it("every exported builder has a decision, and every decision names a real builder", () => {
    expect(Object.keys(DECISIONS).sort()).toEqual(discoveredBuilders());
  });
  it("every file that sends email is listed, and every listed file still sends", () => {
    expect(Object.keys(SEND_SITES).sort()).toEqual(discoveredSendSites());
  });
  it("every builder a send site names has a decision", () => {
    for (const v of Object.values(SEND_SITES)) {
      if (Array.isArray(v)) for (const b of v) expect(DECISIONS[b], b).toBeDefined();
    }
  });
  it("nothing waits for #1051 any more: every decision is enforced", () => {
    expect([...ENFORCED_ON_1051]).toEqual([]);
  });
});

const entries = Object.entries(DECISIONS).flatMap(([name, ds]) => ds.map((d, i) => ({ name, i, d })));

describe("PER_EVENT: distinct events have distinct subjects; one event keeps one", () => {
  const perEvent = entries.filter((e) => e.d.kind === "PER_EVENT" && !ENFORCED_ON_1051.has(e.name));
  it.each(perEvent.map((e) => [`${e.name}#${e.i}`, e.d] as const))("%s", (_label, d) => {
    if (d.kind !== "PER_EVENT") throw new Error("unreachable");
    for (const studio of [SHORTEST, "Synthetic Studio"]) {
      const a = d.build(studio, "K3M9QX").subject;
      const b = d.build(studio, "P7R2TD").subject;
      expect(normalized(a), `${d.event}: two events, one subject`).not.toBe(normalized(b));
      expect(d.build(studio, "K3M9QX").subject).toBe(a);
    }
  });
});

describe("every built email: subject rule and preview at the shortest and a long studio name", () => {
  const buildable = entries.filter((e) => e.d.kind !== "HELD" && !ENFORCED_ON_1051.has(e.name));
  it.each(buildable.map((e) => [`${e.name}#${e.i}`, e.d] as const))("%s", (_label, d) => {
    for (const studio of [SHORTEST, "Synthetic Studio", LONG]) {
      const email = d.kind === "PER_EVENT" ? d.build(studio, "K3M9QX") : d.kind === "SUPERSEDES" ? d.build(studio) : null;
      if (!email) throw new Error("unreachable");
      for (const re of SUBJECT_FORBIDDEN) expect(email.subject, `${studio}: subject ${email.subject}`).not.toMatch(re);
      expect(previewRest(email.html, email.text, email.subject), `${studio}: preview`).toEqual([]);
    }
  });
});

describe("HELD and SUPERSEDES decisions are recorded with a reason", () => {
  it.each(entries.filter((e) => e.d.kind !== "PER_EVENT").map((e) => [`${e.name}#${e.i}`, e.d] as const))("%s", (_l, d) => {
    expect("why" in d && d.why.length > 20).toBe(true);
  });
  it("the shared forbidden list is the preview rule's", () => {
    expect(FORBIDDEN.length).toBeGreaterThan(SUBJECT_FORBIDDEN.length - 1);
  });
});
