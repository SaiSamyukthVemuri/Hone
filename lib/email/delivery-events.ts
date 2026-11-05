import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedResendEvent } from "./resend-webhook";

// DELIVERY-EVENTS-01 — the email delivery-event receipts (migration 0212).
//
//   verify -> record receipt -> acknowledge
//                  |
//                  +-> claim -> process   (now, by the request that recorded it)
//                  +-> claim -> process   (later, by the sweep, if that failed)
//
// The receipt is the durable fact. Once record_email_provider_event has
// committed, the delivery can be acknowledged: processing it is a separate,
// repeatable step that applies the event exactly once
// (process_email_provider_event refuses a receipt that is no longer pending).
// Every processing attempt is counted before it is made, so a receipt that
// keeps failing is quarantined after a bounded number of tries instead of
// stalling the queue.
//
// NEVER THROWS. Each wrapper answers null when the database could not be
// reached or answered something unrecognised, so the route can decide what to
// tell the provider. Logs carry receipt ids, event types and result words:
// never an address, a subject or a payload.

export type ReceiptState =
  | "pending"
  | "applied"
  | "stale"
  | "unmatched"
  | "ignored"
  | "quarantined";

const RECEIPT_STATES = new Set<string>([
  "pending",
  "applied",
  "stale",
  "unmatched",
  "ignored",
  "quarantined",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return typeof row === "object" && row !== null ? (row as Record<string, unknown>) : null;
}

function logReceipt(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

export type RecordedReceipt = {
  result: "recorded" | "duplicate";
  receiptId: string;
  state: ReceiptState;
};

/**
 * Write the durable receipt. Returns null when it could not be written: the
 * route must then refuse the delivery, so the provider retries it.
 */
export async function recordEmailProviderEvent(
  admin: SupabaseClient,
  event: NormalizedResendEvent,
): Promise<RecordedReceipt | null> {
  try {
    const { data, error } = await admin.rpc("record_email_provider_event", {
      p_provider_event_id: event.deliveryId,
      p_event_type: event.eventType,
      p_provider_email_id: event.providerEmailId,
      p_hone_message_id: event.honeMessageId,
      p_provider_created_at: event.providerCreatedAt,
      p_bounce_type: event.bounceType,
      p_bounce_subtype: event.bounceSubtype,
      p_failure_reason: event.failureReason,
      p_suppression_type: event.suppressionType,
    });
    if (error) {
      logReceipt("email_event_record_failed", { shape: "rpc_error" });
      return null;
    }
    const row = firstRow(data);
    const result = row?.result;
    const state = row?.receipt_state;
    if (
      (result === "recorded" || result === "duplicate") &&
      isUuid(row?.receipt_id) &&
      typeof state === "string" &&
      RECEIPT_STATES.has(state)
    ) {
      return { result, receiptId: row.receipt_id as string, state: state as ReceiptState };
    }
    logReceipt("email_event_record_failed", {
      shape: result === "invalid_input" ? "invalid_input" : "unknown_result",
    });
    return null;
  } catch {
    logReceipt("email_event_record_failed", { shape: "threw" });
    return null;
  }
}

/**
 * Claim receipts for processing: exactly `receiptId` when given (it may come
 * back empty when another worker holds it), else a sweep of up to `limit`.
 * Returns the claimed ids, or null when the claim could not be made.
 */
export async function claimEmailProviderEvents(
  admin: SupabaseClient,
  input: { receiptId?: string; limit?: number },
): Promise<string[] | null> {
  try {
    const { data, error } = await admin.rpc("claim_email_provider_events", {
      p_event_id: input.receiptId ?? null,
      p_limit: input.limit ?? null,
    });
    if (error) {
      logReceipt("email_event_claim_failed", { shape: "rpc_error" });
      return null;
    }
    if (!Array.isArray(data)) {
      logReceipt("email_event_claim_failed", { shape: "unknown_result" });
      return null;
    }
    return data
      .map((row) => (typeof row === "object" && row !== null ? (row as Record<string, unknown>).receipt_id : null))
      .filter(isUuid);
  } catch {
    logReceipt("email_event_claim_failed", { shape: "threw" });
    return null;
  }
}

export type ProcessedReceipt = {
  result: Exclude<ReceiptState, "pending"> | "already_processed" | "not_found";
  reason: string | null;
  messageId: string | null;
  /** The studio of the ledger row, only for `applied` and `stale`. */
  studioId: string | null;
  messageStatus: string | null;
};

const PROCESS_RESULTS = new Set<string>([
  "applied",
  "stale",
  "unmatched",
  "ignored",
  "quarantined",
  "already_processed",
  "not_found",
]);

/** Apply one receipt. Null when the attempt failed; the sweep retries it. */
export async function processEmailProviderEvent(
  admin: SupabaseClient,
  receiptId: string,
): Promise<ProcessedReceipt | null> {
  try {
    const { data, error } = await admin.rpc("process_email_provider_event", {
      p_event_id: receiptId,
    });
    if (error) {
      logReceipt("email_event_process_failed", { receiptId, shape: "rpc_error" });
      return null;
    }
    const row = firstRow(data);
    const result = row?.result;
    if (typeof result !== "string" || !PROCESS_RESULTS.has(result)) {
      logReceipt("email_event_process_failed", { receiptId, shape: "unknown_result" });
      return null;
    }
    return {
      result: result as ProcessedReceipt["result"],
      reason: typeof row?.reason === "string" ? row.reason : null,
      messageId: isUuid(row?.message_id) ? (row?.message_id as string) : null,
      studioId: isUuid(row?.message_studio_id) ? (row?.message_studio_id as string) : null,
      messageStatus: typeof row?.message_status === "string" ? row.message_status : null,
    };
  } catch {
    logReceipt("email_event_process_failed", { receiptId, shape: "threw" });
    return null;
  }
}

/**
 * Claim and process the receipt this request just recorded. `held` means
 * another worker has it (or its attempts are spent): nothing to do here.
 */
export async function processReceiptNow(
  admin: SupabaseClient,
  receiptId: string,
): Promise<ProcessedReceipt | "held" | null> {
  const claimed = await claimEmailProviderEvents(admin, { receiptId });
  if (claimed === null) return null;
  if (!claimed.includes(receiptId)) return "held";
  return processEmailProviderEvent(admin, receiptId);
}

export type DrainSummary = { claimed: number; processed: number; failed: number };

/**
 * The recovery sweep: process receipts whose first attempt never finished (a
 * crash, a timeout, a database error). Bounded by `limit`; returns null when
 * nothing could be claimed at all.
 */
export async function drainEmailProviderEvents(
  admin: SupabaseClient,
  input: { limit: number },
): Promise<DrainSummary | null> {
  const claimed = await claimEmailProviderEvents(admin, { limit: input.limit });
  if (claimed === null) return null;
  const summary: DrainSummary = { claimed: claimed.length, processed: 0, failed: 0 };
  for (const receiptId of claimed) {
    const outcome = await processEmailProviderEvent(admin, receiptId);
    if (outcome) summary.processed += 1;
    else summary.failed += 1;
  }
  return summary;
}
