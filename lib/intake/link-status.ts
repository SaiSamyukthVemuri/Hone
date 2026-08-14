// Pure, server-safe smart-status computation for an in-progress intake link
// (PR #303). No DB, no token, no PII, just the display metadata columns
// (migration 0097) plus started_at, turned into the status a practitioner
// reads: when it expires, how many days are left, and which CTA to show.
//
// The signed token remains the authoritative expiry; this is a display mirror.
// Legacy rows (null metadata) fall back to the started_at + TTL heuristic, and
// `usingFallback` is set so the UI can hedge its copy ("may have expired").

import { INTAKE_LINK_TTL_DAYS } from "./queries";

const DAY_MS = 24 * 60 * 60 * 1000;
// A link with this many days (or fewer) left is "close to expiry", prompt the
// practitioner to send a fresh one before the client is locked out mid-form.
export const INTAKE_LINK_CLOSE_TO_EXPIRY_DAYS = 3;

export type IntakeLinkStatusState = "healthy" | "closeToExpiry" | "expired";

export type IntakeLinkButtonLabel =
  | "Resend intake link"
  | "Resend again"
  | "Send fresh link";

export type IntakeLinkStatus = {
  state: IntakeLinkStatusState;
  // ISO of the most recently issued link's expiry (stored, or the started_at
  // heuristic when usingFallback).
  expiresAt: string;
  // Whole days until expiry (ceil); negative once expired.
  daysLeft: number;
  // ISO of the last time the link was actually EMAILED, or null (copy-link /
  // never emailed). Never a delivery/receipt confirmation.
  lastSentAt: string | null;
  sendCount: number;
  // True when expiry was derived from started_at (no stored metadata yet),
  // the UI hedges the copy in this case.
  usingFallback: boolean;
  buttonLabel: IntakeLinkButtonLabel;
};

type IntakeLinkFields = {
  started_at: string;
  intake_link_last_sent_at: string | null;
  intake_link_expires_at: string | null;
  intake_link_send_count: number | null;
};

export function computeIntakeLinkStatus(
  intake: IntakeLinkFields,
  nowMs: number,
): IntakeLinkStatus {
  const stored = intake.intake_link_expires_at;
  const usingFallback = !stored;
  const expiresMs = stored
    ? new Date(stored).getTime()
    : new Date(intake.started_at).getTime() + INTAKE_LINK_TTL_DAYS * DAY_MS;

  const daysLeft = Math.ceil((expiresMs - nowMs) / DAY_MS);
  const expired = expiresMs <= nowMs;
  const closeToExpiry =
    !expired && daysLeft <= INTAKE_LINK_CLOSE_TO_EXPIRY_DAYS;
  const state: IntakeLinkStatusState = expired
    ? "expired"
    : closeToExpiry
      ? "closeToExpiry"
      : "healthy";

  const sendCount = intake.intake_link_send_count ?? 0;
  const buttonLabel: IntakeLinkButtonLabel =
    expired || closeToExpiry
      ? "Send fresh link"
      : sendCount >= 2
        ? "Resend again"
        : "Resend intake link";

  return {
    state,
    expiresAt: new Date(expiresMs).toISOString(),
    daysLeft,
    lastSentAt: intake.intake_link_last_sent_at,
    sendCount,
    usingFallback,
    buttonLabel,
  };
}
