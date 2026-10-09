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
 * Canonical phone digits for matching. Used to compare:
 *   1. a public-booking-submitted phone against a stored client phone
 *      (consent gate in app/book/[slug]/actions.ts),
 *   2. an inbound Twilio STOP From-number against stored client phones
 *      (app/api/twilio/inbound-sms/route.ts).
 *
 * Both surfaces MUST share the same normalization so consent and STOP
 * always resolve to the same client. The earlier "digits only"
 * implementation broke for the common case where one side stored a
 * 10-digit Canadian/US number ("647-555-1234" -> "6475551234") and
 * the other side carried the E.164 country prefix ("+16475551234" ->
 * "16475551234"), so a real client replying STOP could fail to opt
 * out. We now canonicalize through normalizePhoneForSms first (which
 * promotes 10-digit NANP to "+1XXXXXXXXXX" and accepts any
 * +-prefixed international number with 8-15 digits) and only then
 * strip non-digits. The fallback to plain-digit-strip preserves the
 * historical behaviour for inputs we cannot canonicalize.
 *
 * Returns "" for null/empty so callers can compare with strict
 * equality without a null check.
 */
export function normalizePhoneForMatch(raw: string | null): string {
  const e164 = normalizePhoneForSms(raw);
  if (e164) return e164.replace(/\D/g, "");
  if (typeof raw !== "string") return "";
  return raw.replace(/\D/g, "");
}

// ---------------------------------------------------------------------------
// Outbound SMS
// ---------------------------------------------------------------------------

/**
 * What the provider was told, which is a different fact from `retryable`.
 *
 *   none       no request left Hone (not configured, or fenced), so nothing
 *              can exist at the provider;
 *   refused    the provider answered and did not create a message;
 *   ambiguous  a request was made and its answer was lost or unreadable, so a
 *              message MAY exist. Twilio's Messages API takes no idempotency
 *              key, so an ambiguous attempt must never be retried
 *              automatically by a path that cannot tell the two apart.
 */
export type SendSmsAttempt = "none" | "refused" | "ambiguous";

export type SendSmsResult =
  | { ok: true; messageSid: string }
  | {
      ok: false;
      error: string;
      retryable: boolean;
      attempt: SendSmsAttempt;
      /** Twilio's numeric error code, when its error body carried one. */
      providerErrorCode?: number;
    };

type SendSmsParams = {
  to: string;
  body: string;
  /**
   * Absolute URL Twilio should POST this message's delivery-status callbacks
   * to (lib/sms/delivery-ledger.ts builds it). Omitted, Twilio reports nothing.
   */
  statusCallbackUrl?: string | null;
};

const TWILIO_API_BASE = "https://api.twilio.com/2010-04-01";
const TWILIO_SEND_TIMEOUT_MS = 15_000;

// A message SID is the provider's identity for the message; it is checked for
// shape before Hone records it anywhere.
const MESSAGE_SID_RE = /^(SM|MM)[0-9a-fA-F]{32}$/;

// undici `cause.code`s raised before a connection exists, so before any byte
// of the request could have reached the provider.
const PRE_CONNECTION_ERROR_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Whether THIS deployment may send SMS at all.
 *
 * Vercel preview deployments carry the live Twilio credentials and run against
 * the production database, so a preview could text a real person from
 * unreviewed code. Only the production deployment sends; any other Vercel
 * environment is fenced unless an operator deliberately sets
 * HONE_SMS_NON_PRODUCTION_SENDS=allow on it. Outside Vercel (local, CI)
 * there is no VERCEL_ENV and nothing is fenced here: those runs have no live
 * credentials, and tests stub the network.
 */
export function outboundSmsFence(
  env: NodeJS.ProcessEnv = process.env,
): { allowed: true } | { allowed: false; reason: "non_production_deployment" } {
  const vercelEnv = env.VERCEL_ENV;
  if (
    vercelEnv &&
    vercelEnv !== "production" &&
    env.HONE_SMS_NON_PRODUCTION_SENDS !== "allow"
  ) {
    return { allowed: false, reason: "non_production_deployment" };
  }
  return { allowed: true };
}

/** Twilio's numeric error code from a parsed error body, or undefined. */
function providerErrorCodeOf(parsed: unknown): number | undefined {
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const code = (parsed as { code?: unknown }).code;
  return typeof code === "number" && Number.isInteger(code) && code > 0 && code < 100_000_000
    ? code
    : undefined;
}

/**
 * Post one outbound SMS via Twilio Messages API. Never throws; every
 * failure path returns ok:false with a stable error tag and a
 * retryable flag the cron uses to decide whether to attempt again.
 *
 * Configuration:
 *   - A non-production Vercel deployment is fenced (outboundSmsFence)
 *     before any credential is read: ok:false, attempt "none".
 *   - Requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN; missing
 *     either returns ok:false with retryable:false. The caller's job
 *     is to surface this once on startup (settings → launch) rather
 *     than blow up booking.
 *   - Uses TWILIO_MESSAGING_SERVICE_SID when set; otherwise falls
 *     back to TWILIO_FROM_NUMBER. Missing both also returns ok:false.
 *   - `statusCallbackUrl`, when given, becomes Twilio's StatusCallback,
 *     so delivery reports reach /api/twilio/message-status.
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
  // Checked before anything else, so a fenced deployment never even reads
  // the credentials it holds.
  if (!outboundSmsFence().allowed) {
    return {
      ok: false,
      error: "sms_fenced_non_production",
      retryable: false,
      attempt: "none",
    };
  }

  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!accountSid || !authToken) {
    return {
      ok: false,
      error: "twilio_not_configured",
      retryable: false,
      attempt: "none",
    };
  }

  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  if (!messagingServiceSid && !fromNumber) {
    return {
      ok: false,
      error: "twilio_missing_sender",
      retryable: false,
      attempt: "none",
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
  if (params.statusCallbackUrl) {
    formBody.set("StatusCallback", params.statusCallbackUrl);
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
    const rawSid =
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { sid?: unknown }).sid === "string"
        ? ((parsed as { sid: string }).sid as string)
        : null;
    const sid = rawSid !== null && MESSAGE_SID_RE.test(rawSid) ? rawSid : null;

    if (res.ok && sid) {
      return { ok: true, messageSid: sid };
    }

    if (res.ok) {
      // A success status without a well-formed SID: the provider probably
      // created the message, and Hone cannot name it. That is the definition
      // of ambiguous, never a refusal.
      return {
        ok: false,
        error: "twilio_unreadable_success",
        retryable: false,
        attempt: "ambiguous",
      };
    }

    // Map status codes to retryable / non-retryable. 429 + 5xx are
    // transient; 4xx (other than 429) usually means the phone or
    // sender config is wrong and a retry will not help.
    const retryable = res.status === 429 || res.status >= 500;
    const errorTag = `twilio_http_${res.status}`;
    return {
      ok: false,
      error: errorTag,
      retryable,
      // A 4xx (429 included) is the provider answering that it did not create
      // a message. A 5xx is an answer about the provider, not about the
      // message, so it cannot rule out that the message was created.
      attempt: res.status >= 500 ? "ambiguous" : "refused",
      providerErrorCode: providerErrorCodeOf(parsed),
    };
  } catch (err) {
    // AbortController fires AbortError on timeout: the request was sent and
    // its answer lost, so it is ambiguous.
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, error: "twilio_timeout", retryable: true, attempt: "ambiguous" };
    }
    // A connection that was never established (DNS, refused, unreachable,
    // connect timeout) carried no request, so no message can exist: that is
    // a definite non-acceptance, and retrying it cannot send twice.
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    if (typeof code === "string" && PRE_CONNECTION_ERROR_CODES.has(code)) {
      return { ok: false, error: "twilio_unreachable", retryable: true, attempt: "refused" };
    }
    // Any other network failure (a reset mid-request, a broken socket) may
    // have happened after Twilio read the request: ambiguous.
    return { ok: false, error: "twilio_network", retryable: true, attempt: "ambiguous" };
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
