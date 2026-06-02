import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  isStopKeyword,
  maskedPhone,
  normalizePhoneForMatch,
  validateTwilioFormRequest,
} from "@/lib/sms/twilio";

// Twilio inbound SMS webhook (PR Twilio v1).
//
// This route is the ONLY entry point for STOP opt-outs. It is wired
// directly to Twilio's Messaging webhook (configure in the Twilio
// Console -> Messaging Service -> Inbound Settings). The middleware
// allows this path unauthenticated; the route authenticates via the
// X-Twilio-Signature header before touching any DB row.
//
// Security model:
//   1. Read the raw request body as text BEFORE parsing. We must
//      validate the signature against the exact bytes Twilio sent.
//   2. Parse the body as application/x-www-form-urlencoded.
//   3. Build the canonical signed URL: TWILIO_WEBHOOK_BASE_URL +
//      pathname + search if the env var is set; otherwise request.url.
//      The env var path is preferred because the request URL the
//      runtime sees can be the internal Vercel deployment URL rather
//      than the public hone.care URL Twilio actually signed.
//   4. HMAC-SHA1 over the URL plus sorted POST fields; timing-safe
//      compare. validateTwilioFormRequest does this.
//   5. Invalid signature -> 403 and zero DB writes.
//   6. Valid signature: if Body is a STOP keyword, mark every client
//      whose phone (normalized to digits only) matches the From digits
//      as opted out. Audit one row per matched client; STOP failure on
//      the audit insert does not roll back the opt-out (the opt-out
//      is the critical safety action).
//   7. Non-STOP body: empty <Response/>. We do NOT store the body or
//      try to interpret it; v1 is opt-out only, not conversational.
//
// Logging discipline:
//   * Never log full From or To numbers; use maskedPhone().
//   * Never log Body for non-STOP messages (could contain PII).
//   * Never log Auth Token.

// Force Node runtime so node:crypto is available for the HMAC. The
// middleware exception is by exact path, matching this file's route.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STOP_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?>' +
  "<Response><Message>You have been opted out of Hone appointment texts. " +
  "Email reminders may still be sent.</Message></Response>";

const EMPTY_TWIML =
  '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function twimlResponse(body: string): NextResponse {
  return new NextResponse(body, {
    status: 200,
    headers: { "Content-Type": "text/xml; charset=utf-8" },
  });
}

function logEvent(event: string, fields: Record<string, unknown>): void {
  console.log(
    JSON.stringify({
      event,
      ...fields,
      timestamp: new Date().toISOString(),
    }),
  );
}

function logError(event: string, fields: Record<string, unknown>): void {
  console.error(
    JSON.stringify({
      event,
      ...fields,
      timestamp: new Date().toISOString(),
    }),
  );
}

export async function POST(req: Request): Promise<Response> {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!authToken) {
    // No Auth Token configured: we cannot validate the signature, so
    // we must refuse rather than silently accept STOP requests. This
    // is the same posture the Stripe webhook takes when its secret
    // is missing.
    logError("twilio_inbound_missing_auth_token", {});
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // Read raw bytes BEFORE parsing so the signature comparison sees
  // the exact body Twilio signed.
  let rawBody: string;
  try {
    rawBody = await req.text();
  } catch (err) {
    logError("twilio_inbound_body_read_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const signature = req.headers.get("x-twilio-signature");
  if (!signature) {
    logError("twilio_inbound_missing_signature", {});
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // Parse the form body once. The signature validator needs a flat
  // Record<string,string>; the route logic also needs to read named
  // fields below.
  const formParams: Record<string, string> = {};
  try {
    const params = new URLSearchParams(rawBody);
    for (const [key, value] of params.entries()) {
      // URLSearchParams preserves last-occurrence on duplicate keys,
      // which matches Twilio's documented behaviour.
      formParams[key] = value;
    }
  } catch {
    logError("twilio_inbound_body_parse_failed", {});
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  // Build the canonical signed URL. Twilio signs the public URL it
  // was configured with; the request URL the route sees from inside
  // Vercel may be the internal deployment hostname, which would fail
  // validation. Operators set TWILIO_WEBHOOK_BASE_URL=https://hone.care
  // to make this deterministic.
  const requestUrlParsed = new URL(req.url);
  const baseOverride = process.env.TWILIO_WEBHOOK_BASE_URL;
  const signedUrl = baseOverride
    ? `${baseOverride.replace(/\/+$/, "")}${requestUrlParsed.pathname}${requestUrlParsed.search}`
    : req.url;

  const validSignature = validateTwilioFormRequest({
    authToken,
    signature,
    url: signedUrl,
    formParams,
  });
  if (!validSignature) {
    logError("twilio_inbound_invalid_signature", {
      // Do not log the signature or any body field; the From/Body in
      // formParams cannot be trusted yet.
    });
    return NextResponse.json({ ok: false }, { status: 403 });
  }

  // Signature OK. Now we can trust formParams.
  const from = typeof formParams.From === "string" ? formParams.From : "";
  const to = typeof formParams.To === "string" ? formParams.To : "";
  const body = typeof formParams.Body === "string" ? formParams.Body : "";
  const messageSid =
    typeof formParams.MessageSid === "string" ? formParams.MessageSid : null;

  if (!isStopKeyword(body)) {
    // v1 is opt-out only: any other inbound message is acknowledged
    // with an empty TwiML and not persisted. We do not log the body
    // (could be PII); we log only the masked From for traceability.
    logEvent("twilio_inbound_non_stop", {
      fromMasked: maskedPhone(from),
      toMasked: maskedPhone(to),
      messageSid,
    });
    return twimlResponse(EMPTY_TWIML);
  }

  const fromDigits = normalizePhoneForMatch(from);
  if (fromDigits.length === 0) {
    // No digits to match against; nothing to opt out. Still ack with
    // the STOP TwiML so the sender's phone confirms the carrier's
    // STOP filter rather than seeing a silent failure.
    logEvent("twilio_inbound_stop_no_digits", {
      fromMasked: maskedPhone(from),
      messageSid,
    });
    return twimlResponse(STOP_TWIML);
  }

  const admin = createAdminClient();

  // Find every client whose stored phone (normalized to digits only)
  // matches the inbound From. STOP applies phone-wide: if the same
  // number is used across studios (e.g. one client at two clinics),
  // all matching client rows get opted out. This is intentional;
  // phone-number ownership is per-person, not per-studio.
  //
  // We scan with a broad SELECT and filter in-app because the schema
  // stores phone as free text without a normalized index. The pilot
  // scale (single-digit thousands of clients) makes the scan fine for
  // v1; the helper is isolated so a future indexed normalized_phone
  // column can replace this scan without touching the route.
  //
  // Retry-dedup: we also select sms_opted_out_at and skip rows that
  // are already opted out. If Twilio retries this webhook (which it
  // will on the 500 path below when a partial opt-out failure
  // occurred), the second attempt only touches rows that were missed,
  // never re-stamping or double-auditing already-opted-out clients.
  const matchedClients: Array<{ id: string; studio_id: string }> = [];
  let alreadyOptedOutCount = 0;
  try {
    const { data: candidates, error: scanErr } = await admin
      .from("clients")
      .select("id, studio_id, phone, sms_opted_out_at")
      .not("phone", "is", null);
    if (scanErr) throw scanErr;
    for (const row of candidates ?? []) {
      const digits = normalizePhoneForMatch(row.phone);
      if (digits.length > 0 && digits === fromDigits) {
        if (row.sms_opted_out_at) {
          alreadyOptedOutCount += 1;
          continue;
        }
        matchedClients.push({ id: row.id, studio_id: row.studio_id });
      }
    }
  } catch (err) {
    logError("twilio_inbound_client_scan_failed", {
      error: err instanceof Error ? err.message : String(err),
      messageSid,
    });
    // If we cannot scan, we cannot opt out. Return a 500 so Twilio
    // retries; the next attempt may succeed. The carrier already
    // honoured STOP at the network level, so the client will not get
    // any more SMS from Twilio regardless.
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const optedAt = new Date().toISOString();

  // Stamp opt-out on every newly-matched client. Tracking successful
  // rows separately from failed ones is the heart of the P1 fix: a
  // partial failure must NOT be reported to Twilio as 200 (Twilio
  // would not retry, and Hone would be left with an opted-in client
  // who tried to STOP). We attempt every row first so a single bad
  // row does not deny the protection to the others, then decide the
  // HTTP status from the aggregate result.
  //
  // The update filter also adds `is("sms_opted_out_at", null)` as a
  // belt-and-suspenders: if two retries race after the scan but
  // before the updates, the second update is a no-op rather than a
  // double stamp. We treat row-count == 0 in that case as a benign
  // skip (the row was opted out between scan and update), not as an
  // error.
  const successfullyOptedOutClients: Array<{ id: string; studio_id: string }> = [];
  let optOutErrors = 0;
  for (const matched of matchedClients) {
    const { error: updateErr } = await admin
      .from("clients")
      .update({
        sms_opted_out_at: optedAt,
        sms_opt_out_source: "twilio_stop",
      })
      .eq("id", matched.id)
      .is("sms_opted_out_at", null);
    if (updateErr) {
      optOutErrors += 1;
      logError("twilio_inbound_client_optout_failed", {
        clientId: matched.id,
        code: updateErr.code,
        message: updateErr.message,
        messageSid,
      });
    } else {
      // No driver error and we filtered to non-opted-out rows; the
      // stamp either landed on this attempt or this row had been
      // opted out concurrently (benign). Either way, only audit rows
      // that we actually attempted to opt out so a retry that finds
      // everything already opted out produces zero new audit rows.
      successfullyOptedOutClients.push(matched);
    }
  }

  // If ANY matched-client update failed, return 500 so Twilio retries.
  // The successful subset is already persisted and will not be retried
  // (the scan above skips already-opted-out rows). The next attempt
  // only sees the failed subset and either succeeds or 500s again.
  if (optOutErrors > 0) {
    logError("twilio_inbound_stop_partial_optout_failed", {
      matchedCount: matchedClients.length,
      successfulCount: successfullyOptedOutClients.length,
      optOutErrors,
      messageSid,
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  // Audit only successfully-opted-out clients. studio_id is required
  // by the audit_logs table; we set it from the matched client's row.
  // STOP success is NOT contingent on audit success; an audit failure
  // logs but does not roll back the opt-out and does not change the
  // response status. Twilio still receives the STOP TwiML.
  if (successfullyOptedOutClients.length > 0) {
    const auditRows = successfullyOptedOutClients.map((m) => ({
      studio_id: m.studio_id,
      actor_id: null,
      action: "sms_opt_out",
      entity_type: "client",
      entity_id: m.id,
      metadata: {
        source: "twilio_stop",
        twilio_message_sid: messageSid,
        from: maskedPhone(from),
        to: maskedPhone(to),
      },
    }));
    const { error: auditErr } = await admin
      .from("audit_logs")
      .insert(auditRows);
    if (auditErr) {
      logError("twilio_inbound_audit_insert_failed", {
        successfulCount: successfullyOptedOutClients.length,
        code: auditErr.code,
        message: auditErr.message,
        messageSid,
      });
    }
  }

  logEvent("twilio_inbound_stop_processed", {
    fromMasked: maskedPhone(from),
    matchedCount: matchedClients.length,
    alreadyOptedOutCount,
    successfulCount: successfullyOptedOutClients.length,
    messageSid,
  });

  return twimlResponse(STOP_TWIML);
}
