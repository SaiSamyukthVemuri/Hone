// The owner follow-up card's two status lines (Sam, HON-7): the bell and the email are shown on SEPARATE lines and are never merged.
//
// WORDING RULES, each pinned by a test:
//   * While the owner email is not activated its rows are held: the line says the email is off and was not sent. Never "queued" or "pending",
//     because nothing is waiting to go out and activation does not send held rows.
//   * "sent" means the email provider accepted the message. It is never written as "delivered": acceptance is all Hone can know.
//   * Counts only. No name, no address, no provider text.
export const DECLINE_CARD_SAVED = "Response saved. Review the follow-up below.";

/** `notSent` is a held row the sweep will never claim (created before activation, or past its window); see declineOwnerEmailRowEligible. */
export type OutboxCounts = { held: number; sending: number; sent: number; failed: number; cancelled: number; notSent: number };

export function emptyOutboxCounts(): OutboxCounts {
  return { held: 0, sending: 0, sent: 0, failed: 0, cancelled: 0, notSent: 0 };
}

const owners = (n: number): string => (n === 1 ? "1 owner" : `${n} owners`);

/** The bell line. The row is written by the decline command itself, in the same transaction, so a saved response always has one. */
export function bellStatusLine(): string {
  return "Bell: shown to the studio's owners.";
}

/**
 * The email line for one decline. `emailEnabled` is the activation state (flag AND since); `counts` are this decline's outbox rows, or null
 * when they could not be read (which is said, never guessed).
 */
export function emailStatusLine(emailEnabled: boolean, counts: OutboxCounts | null): string {
  if (!emailEnabled) return "Email: off, not sent.";
  if (counts === null) return "Email: status unavailable.";
  const parts: string[] = [];
  if (counts.sent > 0) parts.push(`sent to ${owners(counts.sent)} (accepted by the email provider)`);
  if (counts.sending > 0 || counts.held > 0) parts.push(`sending to ${owners(counts.sending + counts.held)}`);
  if (counts.failed > 0) parts.push(`could not be sent to ${owners(counts.failed)}`);
  if (counts.cancelled > 0) parts.push(`not sent to ${owners(counts.cancelled)} (no longer a verified owner)`);
  if (counts.notSent > 0) parts.push(parts.length === 0 ? "not sent" : `not sent to ${owners(counts.notSent)}`);
  if (parts.length === 0) return "Email: no recipients.";
  return `Email: ${parts.join("; ")}.`;
}
