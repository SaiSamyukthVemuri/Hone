import { escapeHtml } from "@/lib/email/markdown-lite";
import { leadDetailPath, type PlatformLeadKind } from "./alert-status";

// ===========================================================================
// LEAD-ALERT-01 (#826): the operator alert email for one new Hone lead
// ===========================================================================
//
// A BRIEF notice with NO prospect details. It says that a new demo request or early-access signup was saved, when, and gives ONE link to
// the signed-in admin lead list, saying sign-in is required. It carries no name, email, practice, city, practice type, practitioner count,
// tool or notes, and its subject is generic. Whoever receives it learns that a lead exists and nothing about the person: the lead is only
// readable after signing in to /admin, which is gated on the admin allowlist (a recipient of this alert is NOT thereby an admin).
//
// A side effect worth keeping: the message frozen on the alert row (0213) holds no personal data either.
//
// DETERMINISTIC: the output is a pure function of the lead's kind and time and the configured console origin -- no clock, no attempt
// number -- because every retry of one alert reuses its provider idempotency keys, and the provider refuses a key presented with a
// different payload. Nothing submitted reaches any part of it, so there is nothing to escape or flatten.
// ===========================================================================

export type PlatformLeadAlertContent = {
  kind: PlatformLeadKind;
  /** The lead's created_at (ISO). */
  eventAt: string;
};

export type RenderedPlatformLeadAlert = {
  subject: string;
  text: string;
  html: string;
};

/** "2026-10-11 18:05 UTC": the event's own time, never the sending time. */
export function formatEventTime(eventAt: string): string {
  const at = new Date(eventAt);
  if (Number.isNaN(at.getTime())) return "Time not recorded";
  const iso = at.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/**
 * The authenticated console link: the configured origin, never the request's,
 * to the existing /admin lead lists (see leadDetailPath).
 */
export function leadConsoleUrl(
  appOrigin: string,
  kind: PlatformLeadKind,
  leadId: string,
): string {
  return `${appOrigin.replace(/\/+$/, "")}${leadDetailPath(kind, leadId)}`;
}

export function renderPlatformLeadAlert(
  c: PlatformLeadAlertContent,
  consoleUrl: string,
): RenderedPlatformLeadAlert {
  const event = c.kind === "demo_request" ? "demo request" : "early-access signup";
  const subject = `New Hone ${event}`;
  const intro = `A new Hone ${event} was saved.`;
  const received = `Received: ${formatEventTime(c.eventAt)}`;
  const link = "Sign in to the admin console to see it (sign-in required):";
  const footer = "This alert went only to the Hone team. Nothing was sent to the prospect, and it holds no details about them.";

  const text = [intro, received, "", link, consoleUrl, "", footer, ""].join("\n");
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<p>${escapeHtml(received)}</p>`,
    `<p><a href="${escapeHtml(consoleUrl)}">Open the admin lead list</a> (sign-in required).</p>`,
    `<p style="color:#666;">${escapeHtml(footer)}</p>`,
  ].join("\n");
  return { subject, text, html };
}
