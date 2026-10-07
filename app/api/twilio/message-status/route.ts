import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import { validateTwilioFormRequest } from "@/lib/sms/twilio";
import {
  isFailedDeliveryStatus,
  isLedgerMessageId,
  isProviderMessageSid,
  normalizeTwilioMessageStatus,
  recordSmsDeliveryStatus,
} from "@/lib/sms/delivery-ledger";
import { recordOpsAlert } from "@/lib/ops/alerts";

// Twilio message delivery-status callback (SMS-00).
//
// Every outbound SMS that has a ledger row (lib/sms/delivery-ledger.ts) is sent
// with StatusCallback = TWILIO_WEBHOOK_BASE_URL + this path + `?m=<row id>`.
// Twilio POSTs here as the message moves through queued, sent, delivered,
// undelivered or failed. Nothing here sends anything.
//
// Security model, identical to app/api/twilio/inbound-sms/route.ts:
//   1. Read the raw body BEFORE parsing, so the signature check sees the exact
//      bytes Twilio signed.
//   2. Rebuild the signed URL from TWILIO_WEBHOOK_BASE_URL + pathname + search
//      (or request.url when unset). The `m` row id is part of that URL, so it
//      is covered by the signature and cannot be chosen by anyone but Twilio.
//   3. Invalid or missing signature -> 403 and zero DB work.
//
// A recognised callback that cannot be applied (no row id, an inbound status,
// a malformed SID) is acknowledged with 200: it is not something a retry can
// fix. A ledger failure answers 500 so the provider's debugger shows it.
//
// Logging discipline: never To, From or Body. Only the row id, the normalised
// status, Twilio's numeric error code and the command's result word.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(JSON.stringify({ event, ...fields, timestamp: new Date().toISOString() }));
}

function acknowledged(): Response {
  return new NextResponse(null, { status: 200 });
}

/** Twilio's ErrorCode form field, when it is a plain positive integer. */
function errorCodeOf(raw: string | undefined): number | null {
  if (typeof raw !== "string" || !/^\d{1,8}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export async function POST(req: Request): Promise<Response> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    // Without the Auth Token no signature can be checked, so nothing is
    // trusted and nothing is written.
    logError("twilio_status_missing_auth_token", {});
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch {
    logError("twilio_status_body_read_failed", {});
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const signature = req.headers.get("x-twilio-signature");
  if (!signature) {
    logError("twilio_status_missing_signature", {});
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  const formParams: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(rawBody).entries()) {
    formParams[key] = value;
  }

  const requestUrl = new URL(req.url);
  const baseOverride = process.env.TWILIO_WEBHOOK_BASE_URL;
  const signedUrl = baseOverride
    ? `${baseOverride.replace(/\/+$/, "")}${requestUrl.pathname}${requestUrl.search}`
    : req.url;

  if (!validateTwilioFormRequest({ authToken, signature, url: signedUrl, formParams })) {
    logError("twilio_status_invalid_signature", {});
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // Signature OK: the URL and every form field are Twilio's.
  const messageId = requestUrl.searchParams.get("m");
  if (!isLedgerMessageId(messageId)) {
    logEvent("twilio_status_unaddressed", {});
    return acknowledged();
  }

  const sid = formParams.MessageSid;
  if (!isProviderMessageSid(sid)) {
    logEvent("twilio_status_malformed_sid", { messageId });
    return acknowledged();
  }

  const status = normalizeTwilioMessageStatus(formParams.MessageStatus);
  if (!status) {
    logEvent("twilio_status_ignored", { messageId });
    return acknowledged();
  }

  const providerErrorCode = errorCodeOf(formParams.ErrorCode);
  const recorded = await recordSmsDeliveryStatus(createAdminClient(), {
    messageId,
    providerMessageSid: sid,
    status,
    providerErrorCode,
  });
  if (!recorded) {
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  logEvent("twilio_status_recorded", {
    messageId,
    status,
    result: recorded.result,
    providerErrorCode,
  });

  // A message the provider gave up on is the one delivery fact an operator must
  // see. Raised once: only the transition INTO the end state is `updated`, and
  // a repeated or late callback for it answers `stale`.
  if (recorded.result === "updated" && isFailedDeliveryStatus(status)) {
    await recordOpsAlert({
      severity: "warning",
      event: "sms_delivery_failed",
      message: `An SMS (${recorded.purpose ?? "unknown purpose"}) was not delivered: ${status}${
        providerErrorCode ? `, provider error ${providerErrorCode}` : ""
      }.`,
      studioId: recorded.studioId,
      appointmentId: recorded.appointmentId,
      route: "/api/twilio/message-status",
      safeDetails: {
        sms_message_id: messageId,
        purpose: recorded.purpose,
        provider_status: status,
        provider_error_code: providerErrorCode,
      },
    });
  }

  return acknowledged();
}
