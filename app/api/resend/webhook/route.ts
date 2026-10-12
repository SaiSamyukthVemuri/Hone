import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  normalizeResendEvent,
  verifyResendWebhookSignature,
} from "@/lib/email/resend-webhook";
import {
  drainEmailProviderEvents,
  processReceiptNow,
  recordEmailProviderEvent,
} from "@/lib/email/delivery-events";

// Resend delivery-event webhook (DELIVERY-EVENTS-01, migration 0212).
//
// Resend POSTs here as an email moves through sent, delivered, delayed,
// bounced, failed, suppressed or complained. Nothing here sends anything.
//
// Security model:
//   1. Read the raw body BEFORE parsing: the signature covers the exact bytes.
//   2. Verify the Svix signature with RESEND_WEBHOOK_SECRET
//      (lib/email/resend-webhook.ts). Missing or invalid signature, or a
//      timestamp more than five minutes off -> 403 and zero database work.
//   3. Only then parse, and keep only the normalised minimum: no address, no
//      subject and no provider free text reach the database or the logs.
//
// Durability: the receipt is written BEFORE the delivery is acknowledged. If
// it cannot be written the route answers 500 and the provider retries the
// same delivery (same svix-id) on its own schedule.
//
// Recovery (Codex P2 4244387538, 4244798597): when the receipt is STILL
// PENDING after this request -- its own claim or processing attempt failed,
// or another holder's claim kept it from trying -- the answer is also 500.
// Resend's retry of that delivery is then the receipt's recovery trigger.
// A retry that lands while a failed attempt's two-minute claim is still held
// answers 500 again, so the provider keeps retrying (5 s, 5 min, 30 min, ...)
// until one lands after the claim has expired and reclaims it. It never
// depends on a later webhook for some other email or on a scheduled sweep.
// Attempts are bounded in the database: after five, the receipt is
// quarantined and the next retry finds it processed and gets 200, so a
// poison event cannot keep the provider retrying until it disables the
// endpoint. Only an applied, stale, unmatched, ignored or quarantined outcome
// is acknowledged with 200, as is a retried delivery whose receipt is
// already processed.
//
// Attribution: process_email_provider_event attributes an event to a studio
// only through the ledger row it matched. An unmatched or quarantined event
// is attributable to no studio.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Delivery events are a few hundred bytes; anything near this is not one. */
const MAX_BODY_BYTES = 256 * 1024;

/** Receipts each request may help recover after handling its own. */
const SWEEP_LIMIT = 5;

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

type BoundedBody =
  | { kind: "ok"; text: string }
  | { kind: "too_large"; declared: boolean }
  | { kind: "failed" };

/**
 * Reads the request body without ever holding more than `limit` bytes
 * (Codex P2 4248920477). This is a public, unauthenticated endpoint, so the
 * limit has to bound memory and read work, not just what gets verified:
 *   - a declared Content-Length above the limit is refused before reading;
 *   - the stream is counted as it arrives and cancelled the moment it passes
 *     the limit, whatever (or whether) Content-Length was declared.
 * The bytes are decoded as UTF-8 exactly as req.text() would, so the
 * signature still covers the same string.
 */
async function readBoundedBody(req: Request, limit: number): Promise<BoundedBody> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > limit) return { kind: "too_large", declared: true };
  }
  if (!req.body) return { kind: "ok", text: "" };

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large", declared: false };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "failed" };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    bytes.set(c, offset);
    offset += c.byteLength;
  }
  return { kind: "ok", text: new TextDecoder("utf-8").decode(bytes) };
}

export async function POST(req: Request): Promise<Response> {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Without the signing secret nothing can be verified, so nothing is
    // trusted and nothing is written.
    logError("resend_webhook_missing_secret", {});
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const body = await readBoundedBody(req, MAX_BODY_BYTES);
  if (body.kind === "too_large") {
    logError("resend_webhook_body_too_large", { declared: body.declared });
    return NextResponse.json({ ok: false }, { status: 413 });
  }
  if (body.kind === "failed") {
    logError("resend_webhook_body_read_failed", {});
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const rawBody = body.text;

  const verdict = verifyResendWebhookSignature({
    secret,
    headers: req.headers,
    rawBody,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (!verdict.ok) {
    logError("resend_webhook_rejected", { reason: verdict.reason });
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // Signature OK: the body is Resend's. Keep only the normalised minimum.
  const event = normalizeResendEvent(verdict.deliveryId, rawBody);
  const admin = createAdminClient();

  const receipt = await recordEmailProviderEvent(admin, event);
  if (!receipt) {
    // Nothing durable was written: refuse, so the provider delivers it again.
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  if (receipt.result === "duplicate" && receipt.state !== "pending") {
    logEvent("resend_webhook_duplicate", {
      deliveryId: event.deliveryId,
      receiptId: receipt.receiptId,
      state: receipt.state,
    });
    return NextResponse.json({ ok: true });
  }

  const processed = await processReceiptNow(admin, receipt.receiptId);
  logEvent("resend_webhook_received", {
    deliveryId: event.deliveryId,
    receiptId: receipt.receiptId,
    eventType: event.eventType,
    duplicate: receipt.result === "duplicate",
    outcome:
      processed === null ? "processing_failed" : processed === "held" ? "held" : processed.result,
    reason: processed && processed !== "held" ? processed.reason : null,
  });

  // Help finish receipts whose first attempt never completed. Bounded, and
  // its outcome never changes this delivery's answer.
  const sweep = await drainEmailProviderEvents(admin, { limit: SWEEP_LIMIT });
  if (sweep && sweep.claimed > 0) {
    logEvent("resend_webhook_sweep", sweep);
  }

  if (processed === null || processed === "held") {
    // The receipt is still pending: this attempt failed, or a claim (possibly
    // a failed attempt's, not yet expired) kept it from trying. Ask the
    // provider to deliver again, so a later retry recovers it (bounded: the
    // database quarantines it after five attempts, and that retry gets 200).
    return NextResponse.json({ ok: false, recorded: true }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
