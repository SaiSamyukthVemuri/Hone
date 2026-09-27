import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin-server";
import {
  isStopKeyword,
  maskedPhone,
  normalizePhoneForMatch,
  validateTwilioFormRequest,
} from "@/lib/sms/twilio";
import {
  HONE_SUPPRESSION_SCOPE,
  selectHoneSuppressionTargets,
} from "@/lib/sms/suppression";

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
  let matchedClients: Array<{ id: string; studio_id: string }> = [];
  let alreadyOptedOutCount = 0;
  let clientScanFailed = false;
  try {
    const { data: candidates, error: scanErr } = await admin
      .from("clients")
      .select("id, studio_id, phone, sms_opted_out_at")
      .not("phone", "is", null);
    if (scanErr) throw scanErr;
    // COMMS-01B: the phone-wide rule is now a NAMED, TESTED concept in
    // lib/sms/suppression.ts rather than a loop here. Behaviour is unchanged;
    // what changed is that per-studio senders cannot quietly narrow it. Note
    // that `to` is NOT passed: the number a STOP arrived on must never scope
    // who gets opted out. See tests/lib/sms/suppression.test.ts.
    const selection = selectHoneSuppressionTargets({
      candidates: candidates ?? [],
      fromPhone: from,
    });
    matchedClients = selection.targets;
    alreadyOptedOutCount = selection.alreadyOptedOutCount;
  } catch (err) {
    // RECORDED, NOT RETURNED. This used to return 500 here, which was correct
    // while clients were the only record type — but it now sits ABOVE the
    // prospect pass, so a persistent `clients` read failure would stop a
    // perfectly healthy waitlist prospect from ever being suppressed, on every
    // retry. That is the opposite of the isolation this route claims between
    // record types. The 500 still happens; it is just decided once, after both
    // passes have had their turn.
    clientScanFailed = true;
    logError("twilio_inbound_client_scan_failed", {
      error: err instanceof Error ? err.message : String(err),
      messageSid,
    });
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

  // -------------------------------------------------------------------------
  // WAITLIST PROSPECTS — THE SAME RULE, A SECOND RECORD TYPE
  // -------------------------------------------------------------------------
  //
  // 0202 gave waitlist entries the six SMS columns, which made it possible to
  // RECORD a prospect's consent while nothing could honour their STOP. That is
  // the half-promise `ProfileAdapterCapabilities.recordsSmsConsent` exists to
  // refuse, and closing it is this slice.
  //
  // THIS IS NOT A SECOND SUPPRESSION SYSTEM. It calls the same
  // `selectHoneSuppressionTargets` with the same `from`, for the same reason:
  // the phone-wide rule is a statement by a PERSON about their PHONE. A client
  // row and a prospect row that carry the same number are the same human, and
  // one STOP must reach both.
  //
  // `to` is not passed here either. Neither the studio nor the sender the
  // message arrived on may narrow who is opted out.
  //
  // WHY COMMANDS RATHER THAN A TABLE WRITE: 0185 revoked ALL privileges on
  // new_client_waitlist_entries from every role including service_role, so this
  // route holds no DML on those rows. 0202's two commands are the only path,
  // and the stamping one is idempotent (`and e.sms_opted_out_at is null`) and
  // returns the rows it actually stamped — so retry-dedup is the database's
  // answer rather than a count this route infers.
  let matchedProspects: Array<{ id: string; studio_id: string }> = [];
  let prospectsAlreadyOptedOutCount = 0;
  let prospectScanFailed = false;
  try {
    const { data: prospectCandidates, error: prospectScanErr } = await admin.rpc(
      "waitlist_prospect_suppression_candidates",
    );
    if (prospectScanErr) throw prospectScanErr;
    const prospectSelection = selectHoneSuppressionTargets({
      candidates: prospectCandidates ?? [],
      fromPhone: from,
    });
    matchedProspects = prospectSelection.targets;
    prospectsAlreadyOptedOutCount = prospectSelection.alreadyOptedOutCount;
  } catch (err) {
    // Same posture as the client scan: if we cannot read, we cannot suppress,
    // and a 500 lets Twilio retry. Recorded rather than returned immediately so
    // the client rows already stamped above are not re-attempted needlessly.
    prospectScanFailed = true;
    logError("twilio_inbound_prospect_scan_failed", {
      error: err instanceof Error ? err.message : String(err),
      messageSid,
    });
  }

  const successfullyOptedOutProspects: Array<{ id: string; studio_id: string }> = [];
  let prospectOptOutErrors = 0;
  if (matchedProspects.length > 0) {
    const { data: stamped, error: suppressErr } = await admin.rpc(
      "suppress_waitlist_prospects",
      {
        p_entry_ids: matchedProspects.map((m) => m.id),
        p_opted_at: optedAt,
      },
    );
    if (suppressErr) {
      prospectOptOutErrors += 1;
      logError("twilio_inbound_prospect_optout_failed", {
        matchedCount: matchedProspects.length,
        code: suppressErr.code,
        message: suppressErr.message,
        messageSid,
      });
    } else {
      // The command returns only rows it stamped on THIS call, so a retry that
      // finds everything already opted out produces zero audit rows. studio_id
      // comes from the scan, which is the only place it is known.
      const byId = new Map(matchedProspects.map((m) => [m.id, m.studio_id]));
      for (const row of (stamped ?? []) as Array<{ stamped_id: string }>) {
        const studioId = byId.get(row.stamped_id);
        if (studioId) {
          successfullyOptedOutProspects.push({ id: row.stamped_id, studio_id: studioId });
        }
      }
    }
  }

  // If ANY matched-client update failed, return 500 so Twilio retries.
  // The successful subset is already persisted and will not be retried
  // (the scan above skips already-opted-out rows). The next attempt
  // only sees the failed subset and either succeeds or 500s again.

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
        // The opt-out is phone-wide across studios, not scoped to the sender
        // the message arrived on. Recorded so the record says which rule ran.
        suppression_scope: HONE_SUPPRESSION_SCOPE,
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

  // Prospect opt-outs are audited on the same terms as client ones: same
  // action, same phone-wide scope recorded, masked numbers only. The entity
  // type differs because the row does, and a reader should be able to tell a
  // suppressed prospect from a suppressed client without joining anything.
  if (successfullyOptedOutProspects.length > 0) {
    const prospectAuditRows = successfullyOptedOutProspects.map((m) => ({
      studio_id: m.studio_id,
      actor_id: null,
      action: "sms_opt_out",
      entity_type: "new_client_waitlist_entry",
      entity_id: m.id,
      metadata: {
        source: "twilio_stop",
        suppression_scope: HONE_SUPPRESSION_SCOPE,
        twilio_message_sid: messageSid,
        from: maskedPhone(from),
        to: maskedPhone(to),
      },
    }));
    const { error: prospectAuditErr } = await admin
      .from("audit_logs")
      .insert(prospectAuditRows);
    if (prospectAuditErr) {
      // Same posture as the client audit: the opt-out stands, the audit failure
      // is logged, and Twilio still gets its TwiML. An audit row is a record of
      // a suppression that already happened; losing it must not un-suppress.
      logError("twilio_inbound_prospect_audit_insert_failed", {
        successfulCount: successfullyOptedOutProspects.length,
        code: prospectAuditErr.code,
        message: prospectAuditErr.message,
        messageSid,
      });
    }
  }

  // DECIDED AFTER THE AUDITS, DELIBERATELY. This block used to sit above them,
  // so a partial failure returned before either audit ran — and because a retry
  // skips rows already stamped, the audit row for a suppression that DID land
  // was lost for good. A suppression with no record of it is the one outcome
  // neither a person nor an operator can reconstruct later.
  // ONE STATUS FOR BOTH RECORD TYPES. A prospect that could not be read or
  // stamped is exactly as unprotected as a client that could not be, so it
  // earns the same retry. Reporting 200 here would leave a person who texted
  // STOP still opted in, with Twilio never asking again.
  if (
    clientScanFailed ||
    optOutErrors > 0 ||
    prospectOptOutErrors > 0 ||
    prospectScanFailed
  ) {
    logError("twilio_inbound_stop_partial_optout_failed", {
      matchedCount: matchedClients.length,
      successfulCount: successfullyOptedOutClients.length,
      optOutErrors,
      clientScanFailed,
      prospectMatchedCount: matchedProspects.length,
      prospectSuccessfulCount: successfullyOptedOutProspects.length,
      prospectOptOutErrors,
      prospectScanFailed,
      messageSid,
    });
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  logEvent("twilio_inbound_stop_processed", {
    fromMasked: maskedPhone(from),
    matchedCount: matchedClients.length,
    alreadyOptedOutCount,
    successfulCount: successfullyOptedOutClients.length,
    prospectMatchedCount: matchedProspects.length,
    prospectAlreadyOptedOutCount: prospectsAlreadyOptedOutCount,
    prospectSuccessfulCount: successfullyOptedOutProspects.length,
    messageSid,
  });

  return twimlResponse(STOP_TWIML);
}
