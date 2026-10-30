// MSG-LOG-RAW-ERROR. Classify a failure for a log line WITHOUT carrying any of
// its text.
//
// An error's message, stack and body are free text from a database, an SDK or a
// provider. They can quote a constraint's value ("Key (email)=(...)"), a
// destination address, a path, a URL or a record id, and the console drain is a
// third party. A log line therefore carries a CLOSED code instead:
//
//   dbErrorCode(error)        the SQLSTATE or PostgREST code of a database
//                             error, only when it has exactly that shape,
//                             otherwise "unknown";
//   thrownErrorClass(error)   one of a fixed list of classes for anything that
//                             was thrown or caught.
//
// Neither function ever returns a substring of `error.message`, `stack`, a
// body, a header or `cause`. The message IS read by thrownErrorClass to tell
// "fetch failed" from other TypeErrors; only the class leaves.

/** A Postgres SQLSTATE ("23505", "42P01", "55P03") or a PostgREST code ("PGRST116"). */
const SQLSTATE_RE = /^[0-9A-Z]{5}$/;
const POSTGREST_RE = /^PGRST[0-9]{3}$/;

/**
 * The database error's code, or "unknown" (or one of the caller's own `internal`
 * synthetic codes, listed at the call site). `error` is what supabase-js and
 * pg hand back ({ code, message, details, hint }); only `code` is read, and only
 * when it is exactly a SQLSTATE or a PostgREST code.
 */
export function dbErrorCode(error: unknown, internal: readonly string[] = []): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  // `internal` is a CLOSED list written at the call site, for the synthetic codes
  // that code itself puts on a stand-in error object (e.g. "audit_write_unavailable").
  if (typeof code === "string" && internal.includes(code)) return code;
  return safeDbCode(code);
}

/**
 * dbErrorCode() for a read whose caller must tell "the transport failed" from
 * "the database answered with an error" (getStudioBySlug: an unreadable studio
 * is UNKNOWN, never absent, and Sentry groups the two apart). supabase-js
 * reports a transport failure as an error object with no code whose message is
 * exactly "TypeError: fetch failed"; that fixed sentence is the only message
 * this reads, by equality, and it is answered with a fixed label.
 */
export function dbFailureCode(error: unknown): string {
  const code = dbErrorCode(error);
  if (code !== "unknown") return code;
  const message = typeof error === "object" && error !== null ? (error as { message?: unknown }).message : undefined;
  return message === "TypeError: fetch failed" ? "fetch_failed" : "unknown";
}

/** The same rule for a code that was already pulled off an error. */
export function safeDbCode(code: unknown): string {
  if (typeof code !== "string") return "unknown";
  return SQLSTATE_RE.test(code) || POSTGREST_RE.test(code) ? code : "unknown";
}

export const THROWN_ERROR_CLASSES = [
  "abort",
  "timeout",
  "network",
  "type_error",
  "range_error",
  "syntax_error",
  "error",
  "non_error",
] as const;
export type ThrownErrorClass = (typeof THROWN_ERROR_CLASSES)[number];

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);
const TIMEOUT_CODES = new Set([
  "ETIMEDOUT",
  "ESOCKETTIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

function codeOf(value: unknown): string | null {
  if (typeof value !== "object" || value === null) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/**
 * A closed class for a thrown or caught value. A thrown string, number or plain
 * object is "non_error": it is exactly the kind of value that carries data, and
 * it is never logged.
 */
export function thrownErrorClass(error: unknown): ThrownErrorClass {
  if (typeof error !== "object" || error === null) return "non_error";
  const name = (error as { name?: unknown }).name;
  const isError = error instanceof Error || typeof name === "string";
  if (!isError) return "non_error";

  if (name === "AbortError") return "abort";
  if (name === "TimeoutError") return "timeout";

  const own = codeOf(error);
  const cause = codeOf((error as { cause?: unknown }).cause);
  for (const code of [own, cause]) {
    if (code && TIMEOUT_CODES.has(code)) return "timeout";
  }
  for (const code of [own, cause]) {
    if (code && NETWORK_CODES.has(code)) return "network";
  }

  if (error instanceof TypeError) {
    // undici reports a refused or reset connection as TypeError("fetch failed").
    return /^fetch failed$/i.test(String((error as Error).message)) ? "network" : "type_error";
  }
  if (error instanceof RangeError) return "range_error";
  if (error instanceof SyntaxError) return "syntax_error";
  return "error";
}

/** The error `type` names the Stripe SDK documents; anything else is not reported. */
export const STRIPE_ERROR_TYPES = [
  "StripeCardError",
  "StripeInvalidRequestError",
  "StripeAPIError",
  "StripeAuthenticationError",
  "StripePermissionError",
  "StripeRateLimitError",
  "StripeConnectionError",
  "StripeSignatureVerificationError",
  "StripeIdempotencyError",
  "StripeInvalidGrantError",
] as const;
const STRIPE_CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * What a Stripe SDK error may contribute to a log line: its documented type and
 * its machine code ("card_declined", "resource_missing"), each only when it has
 * exactly that shape. Stripe messages quote object ids, card details and request
 * ids, so the message, `raw`, `param` and `decline_code` are never read.
 * Spread it next to thrownErrorClass(): `{ errorClass: thrownErrorClass(err), ...stripeErrorFields(err) }`.
 */
export function stripeErrorFields(error: unknown): { stripeType?: string; stripeCode?: string } {
  if (typeof error !== "object" || error === null) return {};
  const { type, code } = error as { type?: unknown; code?: unknown };
  const out: { stripeType?: string; stripeCode?: string } = {};
  if (typeof type === "string" && (STRIPE_ERROR_TYPES as readonly string[]).includes(type)) out.stripeType = type;
  if (out.stripeType && typeof code === "string" && STRIPE_CODE_RE.test(code)) out.stripeCode = code;
  return out;
}

// snake_case words joined by ':' or '.', e.g. "payment_webhook_maintenance_deferred:charge.refunded"
const LABEL_RE = /^(?=.{3,100}$)[a-z][a-z0-9_]*(?:[:.][a-z0-9_]+)*$/;

/**
 * A short label safe to STORE (not only to log) for a failed unit of work, for
 * example `stripe_events.error`. An Error whose message is itself a bounded
 * machine identifier (`stripe_webhook_payment_original_binding_pending`) is kept
 * as is: those are this codebase's own deliberate failure codes. Anything else
 * is `<fallback>:<class>`, never free text from a database, an SDK or a provider.
 */
export function boundedErrorLabel(error: unknown, fallback = "handler_failed"): string {
  if (error instanceof Error && LABEL_RE.test(error.message)) return error.message;
  return `${fallback}:${thrownErrorClass(error)}`;
}

// snake_case words, as the RPC commands return them ("time_unavailable", "created").
const RESULT_CODE_RE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * The diagnostic code for a failed database call: the database error's closed
 * code when there is an error object, otherwise the command's own RESULT code
 * (a refusal such as "time_unavailable") when it has exactly the shape of one,
 * otherwise `fallback`. A result that is not a bounded identifier is never
 * logged. A nullish fallback after dbErrorCode is dead code (it never
 * returns nullish), so a call that fails by RESULT, with no error object, uses
 * this instead.
 */
export function failureCode(error: unknown, result: unknown, fallback = "unknown"): string {
  if (error) return dbErrorCode(error);
  return typeof result === "string" && RESULT_CODE_RE.test(result) ? result : fallback;
}
