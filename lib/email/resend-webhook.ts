import crypto from "node:crypto";

// DELIVERY-EVENTS-01 — Resend's signed delivery webhooks: verification and
// the minimum this codebase keeps from a payload (migration 0212).
//
// SIGNATURE. Resend signs webhooks with Svix, which follows the Standard
// Webhooks scheme: HMAC-SHA256, keyed with the base64 secret after its
// `whsec_` prefix, over `${svix-id}.${svix-timestamp}.${raw body}`. The
// `svix-signature` header carries one or more space-separated `v1,<base64>`
// signatures (more than one while a secret is being rotated). Hand-rolled on
// node:crypto for the same reason lib/sms/twilio.ts validates Twilio's
// signature itself: the check needs nothing else (no API key, no client
// object), and tests/lib/email/resend-webhook.test.ts holds it to the
// official verifier on the same fixtures.
//
// REPLAY. The timestamp is inside the signed content, so it cannot be moved.
// A delivery more than five minutes from the server's clock, in either
// direction, is refused: a captured request cannot be replayed later. A
// replay within the window carries the same svix-id and is deduplicated by
// the receipt table's unique key, never applied twice.
//
// MINIMUM METADATA. A payload names the sender, the recipients, the subject,
// the provider's free-text messages and any tags. normalizeResendEvent keeps
// only what delivery truth needs, each value shape-checked: the event type,
// the provider email id, the `hone_m` tag (Hone's own ledger row id), the
// event time and identifier-shaped reason codes. A reason that is not a plain
// identifier becomes `other`, so a free-text reason can never carry an
// address through in slug form. Everything else is dropped here, before
// anything is stored or logged.

/** The tag every ledgered send carries: the email_outbound_messages row id. */
export const EMAIL_LEDGER_TAG = "hone_m";

/** Svix's default tolerance: five minutes either side of the server clock. */
export const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DELIVERY_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const EVENT_TYPE_RE = /^[a-z][a-z0-9_.]{1,63}$/;
const IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const TIMESTAMP_RE = /^\d{1,12}$/;

export type SignatureVerdict =
  | { ok: true; deliveryId: string }
  | {
      ok: false;
      reason:
        | "missing_headers"
        | "malformed_delivery_id"
        | "malformed_timestamp"
        | "timestamp_out_of_tolerance"
        | "unusable_secret"
        | "no_matching_signature";
    };

type HeaderSource = { get(name: string): string | null };

function headerOf(headers: HeaderSource, svixName: string, standardName: string): string | null {
  const value = headers.get(svixName) ?? headers.get(standardName);
  return value && value.length > 0 ? value : null;
}

function secretKey(secret: string): Buffer | null {
  const encoded = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  if (encoded.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const key = Buffer.from(encoded, "base64");
  return key.length > 0 ? key : null;
}

/**
 * Verify one webhook delivery against the exact bytes received. Returns the
 * delivery id (svix-id) only when a signature matches; nothing about the body
 * may be trusted, or even parsed, before this says ok.
 */
export function verifyResendWebhookSignature(input: {
  secret: string;
  headers: HeaderSource;
  rawBody: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): SignatureVerdict {
  const deliveryId = headerOf(input.headers, "svix-id", "webhook-id");
  const timestamp = headerOf(input.headers, "svix-timestamp", "webhook-timestamp");
  const signatures = headerOf(input.headers, "svix-signature", "webhook-signature");
  if (!deliveryId || !timestamp || !signatures) return { ok: false, reason: "missing_headers" };
  if (!DELIVERY_ID_RE.test(deliveryId)) return { ok: false, reason: "malformed_delivery_id" };
  if (!TIMESTAMP_RE.test(timestamp)) return { ok: false, reason: "malformed_timestamp" };

  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - Number(timestamp)) > tolerance) {
    return { ok: false, reason: "timestamp_out_of_tolerance" };
  }

  const key = secretKey(input.secret);
  if (!key) return { ok: false, reason: "unusable_secret" };

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${deliveryId}.${timestamp}.${input.rawBody}`)
    .digest();

  for (const entry of signatures.split(" ")) {
    const comma = entry.indexOf(",");
    if (comma < 0 || entry.slice(0, comma) !== "v1") continue;
    const candidate = Buffer.from(entry.slice(comma + 1), "base64");
    if (candidate.length !== expected.length) continue;
    if (crypto.timingSafeEqual(candidate, expected)) return { ok: true, deliveryId };
  }
  return { ok: false, reason: "no_matching_signature" };
}

/** What a receipt stores: shape-checked, no address, no subject, no free text. */
export type NormalizedResendEvent = {
  deliveryId: string;
  /** The provider's type, or `malformed` when the body was not a usable event. */
  eventType: string;
  providerEmailId: string | null;
  honeMessageId: string | null;
  providerCreatedAt: string | null;
  bounceType: string | null;
  bounceSubtype: string | null;
  failureReason: string | null;
  suppressionType: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * An identifier-shaped provider code as a snake_case slug:
 * `OnAccountSuppressionList` -> `on_account_suppression_list`,
 * `reached_daily_quota` stays. Anything that is not a plain identifier (spaces,
 * punctuation, an address) becomes `other`; an absent value stays null.
 */
export function providerCodeSlug(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) return "other";
  const slug = value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase()
    .replace(/_+/g, "_")
    .replace(/_$/, "");
  return /^[a-z][a-z0-9_]{1,63}$/.test(slug) ? slug : "other";
}

function uuidOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const lowered = value.toLowerCase();
  return UUID_RE.test(lowered) ? lowered : null;
}

/** The `hone_m` tag, whether Resend reports tags as an object or as pairs. */
function ledgerTag(tags: unknown): string | null {
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (isRecord(tag) && tag.name === EMAIL_LEDGER_TAG) return uuidOrNull(tag.value);
    }
    return null;
  }
  return isRecord(tags) ? uuidOrNull(tags[EMAIL_LEDGER_TAG]) : null;
}

function instantOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 40) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Reduce a VERIFIED delivery to the receipt's fields. A body that is not JSON,
 * or not an event, still yields a receipt (type `malformed`), so it is kept
 * for review and acknowledged rather than refused into the provider's retry
 * loop.
 */
export function normalizeResendEvent(deliveryId: string, rawBody: string): NormalizedResendEvent {
  const empty: NormalizedResendEvent = {
    deliveryId,
    eventType: "malformed",
    providerEmailId: null,
    honeMessageId: null,
    providerCreatedAt: null,
    bounceType: null,
    bounceSubtype: null,
    failureReason: null,
    suppressionType: null,
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return empty;
  }
  if (!isRecord(parsed) || typeof parsed.type !== "string" || !EVENT_TYPE_RE.test(parsed.type)) {
    return empty;
  }

  const data = isRecord(parsed.data) ? parsed.data : {};
  const bounce = isRecord(data.bounce) ? data.bounce : {};
  const failed = isRecord(data.failed) ? data.failed : {};
  const suppressed = isRecord(data.suppressed) ? data.suppressed : {};

  return {
    deliveryId,
    eventType: parsed.type,
    providerEmailId: uuidOrNull(data.email_id),
    honeMessageId: ledgerTag(data.tags),
    providerCreatedAt: instantOrNull(parsed.created_at),
    bounceType: providerCodeSlug(bounce.type),
    bounceSubtype: providerCodeSlug(bounce.subType),
    failureReason: providerCodeSlug(failed.reason),
    suppressionType: providerCodeSlug(suppressed.type),
  };
}
