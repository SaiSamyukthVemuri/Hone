import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailSendResult } from "./send-appointment";

// DELIVERY-VISIBILITY-01 — joining a send path to the email delivery ledger
// (migration 0212, email_outbound_messages).
//
//   begin -> send (tagged hone_m = row id) -> settle -> signed delivery events
//
// The row exists BEFORE the provider is called, so a delivery event addressed
// by the tag lands on it even when this call's own answer is lost, and a later
// event turns an `unknown` settle into the truth.
//
// FAIL-SOFT. Recording an attempt is bookkeeping: if the ledger cannot be
// written, the send it describes happens exactly as it did before the ledger
// existed, just without a tag. Nothing here decides whether to send, and
// nothing here ever resends: the caller's own claim (0080 for reminders) stays
// the send authority.
//
// PRIVACY. Nothing here writes or logs an address, a subject or a body. The
// ledger holds purpose, subject, status, the provider email id and slugs.

export type AppointmentEmailPurpose =
  | "appointment_confirmation"
  | "appointment_reminder_24h"
  | "appointment_reminder_2h"
  // 0221 (DELIVERY-VISIBILITY-04)
  | "appointment_cancellation"
  | "appointment_postcare";

/** Why a begun attempt made no provider call. A closed vocabulary. */
export const EMAIL_SKIP_REASONS = ["provider_not_configured", "no_recipient"] as const;
export type EmailSkipReason = (typeof EMAIL_SKIP_REASONS)[number];

export type EmailSettleOutcome =
  | { outcome: "accepted"; providerEmailId: string }
  | { outcome: "refused" | "unknown"; providerError: string | null }
  | { outcome: "skipped"; skipReason: EmailSkipReason };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isEmailLedgerId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value.toLowerCase());
}

/**
 * The provider's error as a slug for the ledger, never its free-text message:
 * a plain lowercase identifier is kept, anything else is generalised.
 */
function errorSlug(message: string, fallback: string): string {
  const lowered = message.trim().toLowerCase();
  if (/^[a-z][a-z0-9_]{1,63}$/.test(lowered)) return lowered;
  if (/timeout/.test(lowered)) return "timeout";
  return fallback;
}

/** What the transport's answer means for the ledger. */
export function settleOutcomeForEmailSend(result: EmailSendResult): EmailSettleOutcome {
  if (result.ok) {
    const id = result.messageId?.toLowerCase();
    // An acceptance without a recognisable id cannot be correlated by id; the
    // tag still can, so the row waits as `unknown` for the provider's report.
    return isEmailLedgerId(id)
      ? { outcome: "accepted", providerEmailId: id }
      : { outcome: "unknown", providerError: "no_message_id" };
  }
  switch (result.attempt) {
    case "none":
      return {
        outcome: "skipped",
        skipReason: /not configured/i.test(result.error) ? "provider_not_configured" : "no_recipient",
      };
    case "refused":
      return { outcome: "refused", providerError: errorSlug(result.error, "provider_refused") };
    default:
      // `ambiguous`, or a caller-built failure that never reached the
      // transport classification: never claim a refusal that is not known.
      return { outcome: "unknown", providerError: errorSlug(result.error, "ambiguous") };
  }
}

function logLedger(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

// LEDGER BOOKKEEPING IS BOUNDED (Codex P2 4307424676).
//
// Both wrappers below already return null when the RPC REJECTS. They did not
// cover the RPC that STALLS -- a degraded Supabase connection that neither
// answers nor errors. The await was unbounded, and the surrounding try/catch
// only ever covered client construction, so the documented fail-soft behaviour
// did not apply: `sendEmailSafely` was never reached, and because every booking
// flow awaits its sender AFTER committing the appointment, the request could
// exhaust its runtime having written an appointment and sent NO confirmation.
//
// A timeout is therefore treated exactly as a write failure already is: return
// null, log it, and let the caller send UNTAGGED. Losing the ledger row costs
// attribution; losing the confirmation costs the client their email.
//
// 2s follows the precedent for non-critical bookkeeping in this repository
// (`DISPATCH_TIMEOUT_MS`, lib/analytics/server.ts) and sits far below any
// serverless request budget. The timer is ALWAYS cleared: a pending timer keeps
// Node's event loop alive, so leaking one would delay the very response this
// bound exists to protect.
const LEDGER_RPC_TIMEOUT_MS = 2_000;

const LEDGER_TIMED_OUT = Symbol("ledger_rpc_timeout");

async function withLedgerTimeout<T>(
  work: PromiseLike<T>,
): Promise<T | typeof LEDGER_TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race<T | typeof LEDGER_TIMED_OUT>([
      work,
      new Promise<typeof LEDGER_TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(LEDGER_TIMED_OUT), LEDGER_RPC_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Create the ledger row for one appointment email attempt, AFTER the caller's
 * own send claim. Returns the row id, or null when it could not be written --
 * the caller then sends exactly as before, untagged.
 */
export async function beginAppointmentEmailMessage(
  admin: SupabaseClient,
  input: { studioId: string; appointmentId: string; purpose: AppointmentEmailPurpose },
): Promise<string | null> {
  try {
    const raced = await withLedgerTimeout(
      admin.rpc("begin_appointment_email_message", {
        p_studio_id: input.studioId,
        p_appointment_id: input.appointmentId,
        p_purpose: input.purpose,
      }),
    );
    if (raced === LEDGER_TIMED_OUT) {
      logLedger("email_ledger_begin_failed", { purpose: input.purpose, shape: "timeout" });
      return null;
    }
    const { data, error } = raced;
    if (error) {
      logLedger("email_ledger_begin_failed", { purpose: input.purpose, shape: "rpc_error" });
      return null;
    }
    return isEmailLedgerId(data) ? data : null;
  } catch {
    logLedger("email_ledger_begin_failed", { purpose: input.purpose, shape: "threw" });
    return null;
  }
}

export type EmailSettleResult =
  | "settled"
  | "already_settled"
  | "id_conflict"
  | "not_found"
  | "not_claimed"
  | "invalid_input";

const SETTLE_RESULTS = new Set<string>([
  "settled",
  "already_settled",
  "id_conflict",
  "not_found",
  "not_claimed",
  "invalid_input",
]);

/**
 * Record what the provider answered. Never throws: the send it describes has
 * already happened (or definitely has not) either way.
 */
export async function settleEmailMessage(
  admin: SupabaseClient,
  messageId: string,
  settle: EmailSettleOutcome,
): Promise<EmailSettleResult | null> {
  try {
    // Bounded for the same reason, and it matters even more here: the send this
    // describes has ALREADY happened, so stalling on the bookkeeping would
    // delay a response that has nothing left to decide.
    const raced = await withLedgerTimeout(
      admin.rpc("settle_email_message", {
        p_message_id: messageId,
        p_outcome: settle.outcome,
        p_provider_email_id: settle.outcome === "accepted" ? settle.providerEmailId : null,
        p_provider_error:
          settle.outcome === "refused" || settle.outcome === "unknown" ? settle.providerError : null,
        p_skip_reason: settle.outcome === "skipped" ? settle.skipReason : null,
      }),
    );
    if (raced === LEDGER_TIMED_OUT) {
      logLedger("email_ledger_settle_failed", { outcome: settle.outcome, shape: "timeout" });
      return null;
    }
    const { data, error } = raced;
    if (error) {
      logLedger("email_ledger_settle_failed", { outcome: settle.outcome, shape: "rpc_error" });
      return null;
    }
    if (typeof data === "string" && SETTLE_RESULTS.has(data)) {
      if (data !== "settled" && data !== "already_settled") {
        logLedger("email_ledger_settle_refused", { outcome: settle.outcome, result: data });
      }
      return data as EmailSettleResult;
    }
    logLedger("email_ledger_settle_failed", { outcome: settle.outcome, shape: "unknown_result" });
    return null;
  } catch {
    logLedger("email_ledger_settle_failed", { outcome: settle.outcome, shape: "threw" });
    return null;
  }
}
