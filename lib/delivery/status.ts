// DELIVERY-EVENTS-01 — one delivery vocabulary for every channel.
//
// The ledgers record what Hone and each provider SAID, in the provider's
// terms: sms_outbound_messages (0206) for Twilio and email_outbound_messages
// (0212) for Resend. A person reading about a client's reminder needs one
// vocabulary instead, and it has to be truthful in four ways #824 names:
//
//   * ACCEPTED IS NOT DELIVERED. A provider taking a message says nothing
//     about whether it arrived.
//   * DELIVERED IS NOT READ. For email it means the recipient's mail server
//     accepted the message; it is never evidence of the inbox, an open or a
//     reading. Opens and clicks are not inputs here at all.
//   * UNKNOWN IS NOT SUCCESS. An answer that was lost, or a report that never
//     came, is shown as unknown or stale, never as delivered.
//   * Each failure is named for what it is: bounced (the recipient's server
//     refused it), failed (the provider refused or could not send it),
//     suppressed (the provider would not send to that address).
//
// The vocabulary is channel-agnostic so a later owner/support view can read
// both ledgers through it. Only the email mapping exists so far; SMS joins
// when that view does.

export type DeliveryDisplayState =
  | "queued"
  | "not_sent"
  | "unknown"
  | "provider_accepted"
  | "delayed"
  | "delivered"
  | "bounced"
  | "failed"
  | "suppressed"
  | "stale";

export const DELIVERY_STATE_MEANING: Readonly<Record<DeliveryDisplayState, string>> = {
  queued: "Hone is sending this. The provider has not answered yet.",
  not_sent: "Hone did not send this. A send rule stopped it before any provider was asked.",
  unknown:
    "A send was attempted, but its outcome is unknown. It may or may not have been sent.",
  provider_accepted: "The provider accepted this. No delivery has been reported yet.",
  delayed: "The provider is retrying after a temporary delivery problem.",
  delivered:
    "The provider reported that the recipient's mail server or carrier accepted this. That does not mean it was seen or read.",
  bounced: "The recipient's mail server or carrier rejected this permanently.",
  failed: "The provider refused this or could not send it.",
  suppressed:
    "The provider did not send this because the recipient is on its suppression list.",
  stale:
    "The provider accepted this, but no delivery outcome was reported in time. Treat it as unknown, not as delivered.",
};

export type DeliveryView = {
  state: DeliveryDisplayState;
  /**
   * No further provider report is expected. `delivered` counts as final even
   * though a late bounce can still supersede it (and, in the ledger, does).
   */
  final: boolean;
  /** A person should look: the outcome is a failure, or is not known. */
  attention: boolean;
  /** The recipient reported the message as spam. Email only; implies delivered. */
  complained: boolean;
};

const ATTENTION = new Set<DeliveryDisplayState>([
  "unknown",
  "bounced",
  "failed",
  "suppressed",
  "stale",
]);

function view(state: DeliveryDisplayState, final: boolean, complained = false): DeliveryView {
  return { state, final, attention: ATTENTION.has(state), complained };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** email_outbound_messages.status, as migration 0212 constrains it. */
export type EmailLedgerStatus =
  | "claimed"
  | "skipped"
  | "refused"
  | "unknown"
  | "accepted"
  | "sent"
  | "delivery_delayed"
  | "delivered"
  | "bounced"
  | "failed"
  | "suppressed";

export type EmailDeliveryRow = {
  status: EmailLedgerStatus;
  claimedAt: string;
  settledAt: string | null;
  providerStatusAt: string | null;
  complainedAt: string | null;
};

/**
 * When silence stops being "in progress" and becomes "unknown". Purpose-
 * specific thresholds belong to the alerting slice; these are the floor the
 * display never goes below.
 */
export const EMAIL_STALENESS = {
  /** A claim its sender never settled: it crashed or timed out mid-send. */
  unsettledClaimMs: 15 * 60_000,
  /** Accepted or sent, with no delivery report since. */
  noReportMs: 24 * 60 * 60_000,
  /** Still delayed: receiving servers give up within a few days. */
  delayedMs: 72 * 60 * 60_000,
} as const;

function ageMs(now: Date, ...instants: Array<string | null>): number {
  for (const instant of instants) {
    if (!instant) continue;
    const ms = Date.parse(instant);
    if (Number.isFinite(ms)) return now.getTime() - ms;
  }
  return 0;
}

export function emailDeliveryView(
  row: EmailDeliveryRow,
  now: Date,
  limits: typeof EMAIL_STALENESS = EMAIL_STALENESS,
): DeliveryView {
  const complained = row.complainedAt !== null;
  switch (row.status) {
    case "claimed":
      return ageMs(now, row.claimedAt) > limits.unsettledClaimMs
        ? view("unknown", false)
        : view("queued", false);
    case "skipped":
      return view("not_sent", true);
    case "refused":
      return view("failed", true);
    case "unknown":
      // A late provider report can still resolve it, so it is not final.
      return view("unknown", false);
    case "accepted":
    case "sent":
      return ageMs(now, row.providerStatusAt, row.settledAt, row.claimedAt) > limits.noReportMs
        ? view("stale", false)
        : view("provider_accepted", false);
    case "delivery_delayed":
      return ageMs(now, row.providerStatusAt, row.settledAt, row.claimedAt) > limits.delayedMs
        ? view("stale", false)
        : view("delayed", false);
    case "delivered":
      return view("delivered", true, complained);
    case "bounced":
      return view("bounced", true, complained);
    case "failed":
      return view("failed", true, complained);
    case "suppressed":
      return view("suppressed", true, complained);
  }
}
