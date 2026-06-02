import crypto from "node:crypto";

// Twilio SMS helpers used by the booking, reschedule, reminder cron,
// and inbound STOP webhook paths. Implementation deliberately avoids
// the `twilio` npm package; we call the REST API with `fetch`. This
// keeps the dependency footprint small and the security model easy to
// reason about (Basic Auth on outbound; HMAC-SHA1 signature on
// inbound; no SDK glue in the middle).
//
// Every helper here is pure or side-effect-isolated:
//   * normalizePhoneForSms - format coercion only
//   * normalizePhoneForMatch - digit-extraction only
//   * sendSmsSafely - one fetch + JSON parse; never logs Auth Token
//     or full phone numbers
//   * validateTwilioFormRequest - HMAC-SHA1 + timing-safe compare
//   * isStopKeyword - uppercase trim + small allowlist
//   * maskedPhone - log-only mask
//
// Nothing in this file reads or writes the database; the send-appointment
// helpers in lib/sms/send-appointment.ts wrap these primitives with the
// claim-and-record cycle.

// ---------------------------------------------------------------------------
// Phone normalization
// ---------------------------------------------------------------------------

const VALID_E164_DIGIT_RANGE = { min: 8, max: 15 } as const;

/**
 * Normalize a free-text phone string into Twilio-acceptable E.164
 * format (`+` followed by 8-15 digits). Returns null for anything we
 * cannot safely coerce; the caller treats null as "do not send SMS".
 *
 * Rules:
 *   - `+` prefix kept verbatim if the digits after it land in 8..15.
 *   - 10 digits assumed North-America-Numbering-Plan and prepended
 *     with `+1` (Hone is currently Canadian-only).
 *   - 11 digits starting with `1` get a `+` prepended.
 *   - Anything else returns null. We deliberately do not guess country
 *     codes for international numbers; an invalid Twilio destination
 *     would surface as a non-retryable error anyway.
 */
export function normalizePhoneForSms(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    if (
      digits.length >= VALID_E164_DIGIT_RANGE.min &&
      digits.length <= VALID_E164_DIGIT_RANGE.max
    ) {
      return `+${digits}`;
    }
    return null;
  }

  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/**
 * Strip a phone string down to digits only. Used to compare:
 *   1. a public-booking-submitted phone against a stored client phone
 *      (consent gate in app/book/[slug]/actions.ts),
 *   2. an inbound Twilio STOP From-number against stored client phones
 *      (lib/sms/twilio.ts findClientsByPhoneDigits).
 *
 * Both surfaces MUST share the same normalization so consent and STOP
 * always resolve to the same client. Pure; returns "" for null/empty
 * so callers can compare with strict equality without a null check.
 */
export function normalizePhoneForMatch(raw: string | null): string {
  if (typeof raw !== "string") return "";
  return raw.replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// Outbound SMS
// ---------------------------------------------------------------------------

export type SendSmsResult =
  | { ok: true; messageSid: string }
  | { ok: false; error: string; retryable: boolean };

type SendSmsParams = {
  to: string;
  body: string;
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const TWILIO_SEND_TIMEOUT_MS = 15_000;

/**
 * Post one outbound SMS via Twilio Messages API. Never throws; every
 * failure path returns ok:false with a stable error tag and a
 * retryable flag the cron uses to decide whether to attempt again.
 *
 * Configuration:
 *   - Requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN; missing
 *     either returns ok:false with retryable:false. The caller's job
 *     is to surface this once on startup (settings → launch) rather
 *     than blow up booking.
 *   - Uses TWILIO_MESSAGING_SERVICE_SID when set; otherwise falls
 *     back to TWILIO_FROM_NUMBER. Missing both also returns ok:false.
 *
 * Logging discipline:
 *   - Auth Token is never logged.
 *   - Full phone numbers are never logged; use maskedPhone() for the
 *     few fields we do log.
 *   - The Twilio response body (which can echo `To`) is summarized
 *     down to messageSid + status; we do not dump the raw body.
 */
export async function sendSmsSafely(
  params: SendSmsParams,
): Promise<SendSmsResult> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return {
      ok: false,
      error: "twilio_not_configured",
      retryable: false,
    };
  }

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!messagingServiceSid && !fromNumber) {
    return {
      ok: false,
      error: "twilio_missing_sender",
      retryable: false,
    };
  }

  const formBody = new URLSearchParams();
  formBody.set("To", params.to);
  formBody.set("Body", params.body);
  if (messagingServiceSid) {
    formBody.set("MessagingServiceSid", messagingServiceSid);
  } else if (fromNumber) {
    formBody.set("From", fromNumber);
  }

  const url = `${TWILIO_API_BASE}/Accounts/${encodeURIComponent(
    accountSid,
  )}/Messages.json`;
  const basicAuth = Buffer.from(`${accountSid}:${authToken}`).toString(
    "base64",
  );

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TWILIO_SEND_TIMEOUT_MS,
  );

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basicAuth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: formBody.toString(),
      signal: controller.signal,
    });

    // Twilio returns JSON on both success and most error responses.
    let parsed: unknown = null;
    try {
      parsed = await res.json();
    } catch {
      // Some 5xx responses are HTML or empty; treat as retryable.
    }
    const sid =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { sid?: unknown }).sid === "string"
        ? ((parsed as { sid: string }).sid as string)
        : null;

    if (res.ok && sid) {
      return { ok: true, messageSid: sid };
    }

    // Map status codes to retryable / non-retryable. 429 + 5xx are
    // transient; 4xx (other than 429) usually means the phone or
    // sender config is wrong and a retry will not help.
    const retryable = res.status === 429 || res.status >= 500;
    const errorTag = `twilio_http_${res.status}`;
    return { ok: false, error: errorTag, retryable };
  } catch (err) {
    // AbortController fires AbortError on timeout. Network failures
    // come through as TypeError. Both are retryable.
    const tag =
      err instanceof Error && err.name === "AbortError"
        ? "twilio_timeout"
        : "twilio_network";
    return { ok: false, error: tag, retryable: true };
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook signature validation
// ---------------------------------------------------------------------------

type ValidateTwilioParams = {
  authToken: string;
  signature: string;
  url: string;
  formParams: Record<string, string>;
};

/**
 * Validate a Twilio inbound webhook signature per the official spec:
 *   1. Concatenate the FULL request URL.
 *   2. Append each POST field, sorted by key, as `key + value` (no
 *      separators).
 *   3. HMAC-SHA1 the result with the Twilio Auth Token.
 *   4. Base64-encode and compare timing-safely to the X-Twilio-Signature
 *      header.
 *
 * Returns true on match, false otherwise (including missing/garbled
 * signature). The caller must reject 403 if this returns false BEFORE
 * doing any DB work or trusting any field in formParams.
 *
 * Reference: https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function validateTwilioFormRequest(
  params: ValidateTwilioParams,
): boolean {
  if (!params.authToken || !params.signature) return false;

  // Sorted key+value concatenation, exactly as Twilio's reference
  // implementations do (no URI escaping, no separators).
  const sortedKeys = Object.keys(params.formParams).sort();
  let payload = params.url;
  for (const key of sortedKeys) {
    payload += key;
    payload += params.formParams[key] ?? "";
  }

  const hmac = crypto.createHmac("sha1", params.authToken);
  hmac.update(payload);
  const expected = hmac.digest("base64");

  // Length-equal timingSafeEqual; mismatched lengths short-circuit to
  // false (timingSafeEqual would throw otherwise).
  const expectedBuf = Buffer.from(expected, "utf8");
  const actualBuf = Buffer.from(params.signature, "utf8");
  if (expectedBuf.length !== actualBuf.length) return false;
  try {
    return crypto.timingSafeEqual(expectedBuf, actualBuf);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// STOP keyword detection
// ---------------------------------------------------------------------------

const STOP_KEYWORDS = new Set<string>([
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
]);

/**
 * True if the body is one of the recognized opt-out keywords. We
 * uppercase + trim before checking and treat the entire body as the
 * keyword (Twilio's STOP filter behaves the same way). Anything else,
 * including stylized STOP-LIKE words ("STOP PLEASE", "stop everything"),
 * does NOT match; this is intentionally conservative for v1.
 */
export function isStopKeyword(body: string | null | undefined): boolean {
  if (typeof body !== "string") return false;
  const normalized = body.trim().toUpperCase();
  return STOP_KEYWORDS.has(normalized);
}

// ---------------------------------------------------------------------------
// Log masking
// ---------------------------------------------------------------------------

/**
 * Mask a phone number for safe logging. Keeps the country prefix and
 * the last 2 digits so a humans-eye scan can distinguish numbers; the
 * middle digits are replaced with `***`. Returns the literal string
 * "(no phone)" for null/empty so logs never blank out.
 */
export function maskedPhone(raw: string | null | undefined): string {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return "(no phone)";
  }
  const trimmed = raw.trim();
  // Show the first 2 visible chars and the last 2; mask the middle.
  if (trimmed.length <= 4) return "****";
  const head = trimmed.slice(0, 2);
  const tail = trimmed.slice(-2);
  return `${head}***${tail}`;
}
